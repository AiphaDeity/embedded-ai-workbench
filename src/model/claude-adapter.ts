import type { ModelAdapter, ModelRequest, ModelEvent, ChatMessage, ModelToolSpec } from './adapter.js';

// Anthropic (Claude) 适配器（契约实现）。
// 真实调用需在环境变量注入 apiKey；无凭据时不加载，仅保留接口与契约（B 验证结论：未验证）。
export interface ClaudeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

// 纯函数：将内部消息映射为 Anthropic 请求体。
// 审查项 1：assistant 若携带 toolCalls，必须渲染成含 tool_use 块的 assistant 消息，
// 后接 user(tool_result)。缺失 assistant(tool_use) 时 Anthropic 会拒绝。
export function toAnthropicMessages(
  messages: ChatMessage[]
): { system?: string; messages: Array<Record<string, unknown>> } {
  let system: string | undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = m.content;
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content && m.content.length > 0) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.toolId, input: tc.args });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system, messages: out };
}

// 纯函数：解析 Anthropic SSE（event:/data: 行流）→ 事件流（抽离便于直接单测）。
// 多个 tool_use 块的 input_json 可能跨多个 content_block_delta 片段累积（审查项 2 / 测试项 6）。
export async function* parseClaudeChatStream(
  lines: AsyncIterable<string>
): AsyncIterable<ModelEvent> {
  const toolBuf: Array<{ id: string; name: string; args: string }> = [];
  let currentTool: { id: string; name: string; args: string } | null = null;
  for await (const trimmed of lines) {
    const t = trimmed.trim();
    if (!t.startsWith('event:') && !t.startsWith('data:')) continue;
    const idx = t.indexOf(':');
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (key !== 'data') continue;
    try {
      const json = JSON.parse(val);
      if (json.type === 'content_block_delta') {
        const delta = json.delta;
        if (delta?.type === 'text_delta') yield { type: 'text', delta: String(delta.text) };
        if (delta?.type === 'input_json_delta' && currentTool) {
          currentTool.args += delta.partial_json ?? '';
        }
      } else if (json.type === 'content_block_start') {
        const cb = json.content_block;
        if (cb?.type === 'tool_use') {
          currentTool = { id: String(cb.id), name: String(cb.name), args: '' };
          toolBuf.push(currentTool);
        }
      } else if (json.type === 'content_block_stop') {
        currentTool = null;
      } else if (json.type === 'message_stop') {
        break;
      }
    } catch {
      // 跳过不完整分片
    }
  }

  // 流结束后整体解析累积参数；失败显式报错（审查项 2）
  for (const tc of toolBuf) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.args || '{}');
    } catch {
      throw new Error(`claude tool_use ${tc.name || tc.id} 参数不是合法 JSON: ${tc.args}`);
    }
    yield { type: 'tool_call', id: tc.id, toolId: tc.name, args };
  }
  yield { type: 'done', finishReason: 'stop' };
}

export class ClaudeAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  constructor(private cfg: ClaudeConfig) {}
  get model(): string {
    return this.cfg.model;
  }

  async *chat(req: ModelRequest): AsyncIterable<ModelEvent> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body = {
      model: this.cfg.model,
      max_tokens: 4096,
      stream: true,
      ...(system ? { system } : {}),
      messages,
      tools: req.tools.map((t: ModelToolSpec) => ({
        name: t.id,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
    const res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`claude http ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    async function* readLines() {
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const ls = buf.split('\n');
        buf = ls.pop() ?? '';
        for (const l of ls) yield l;
      }
    }
    yield* parseClaudeChatStream(readLines());
  }
}
