import type { ModelAdapter, ModelRequest, ModelEvent, ChatMessage, ModelToolSpec } from './adapter.js';

// OpenAI 兼容适配器（契约实现）。
// 真实调用需在环境变量注入 apiKey；无凭据时不加载，仅保留接口与契约（B 验证结论：未验证）。
export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

// 纯函数：将内部消息映射为 OpenAI 请求消息。
// 审查项 1：assistant 若携带 toolCalls，必须渲染成带 tool_calls 的 assistant 消息，
// 且 tool 角色消息要带 tool_call_id —— 否则第二轮请求缺历史、服务端拒绝。
export function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        // OpenAI 要求携带 tool_calls 时 content 必须为 null（不可为空字符串）
        content: m.content && m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.toolId, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === 'tool') {
      base['tool_call_id'] = m.toolCallId;
      base['name'] = m.toolName;
    }
    return base;
  });
}

// 纯函数：解析 OpenAI SSE 文本流 → 事件流（抽离便于直接单测「跨分片参数累积 / 无效参数」）。
// 关键：tool_call 的 arguments 可能跨多个增量片段到达，必须按索引累积到流结束才整体解析；
// 最终解析失败必须显式抛错（审查项 2 / 测试项 6）。
export async function* parseOpenAIChatStream(
  chunks: AsyncIterable<string>
): AsyncIterable<ModelEvent> {
  let buf = '';
  // 按 tool_call 索引累积参数片段，避免「参数被丢弃 / 完整 JSON 转成 {}」
  const tcBuf: Array<{ id: string; name: string; args: string }> = [];
  const queue: ModelEvent[] = []; // handleLine 无法直接 yield，先入队
  let finished = false;

  const handleLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) queue.push({ type: 'text', delta: String(delta.content) });
      const tcs = delta?.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = typeof tc.index === 'number' ? tc.index : tcBuf.length;
          if (!tcBuf[idx]) tcBuf[idx] = { id: '', name: '', args: '' };
          if (tc.id) tcBuf[idx].id = String(tc.id);
          if (tc.function?.name) tcBuf[idx].name = String(tc.function.name);
          if (typeof tc.function?.arguments === 'string') tcBuf[idx].args += tc.function.arguments;
        }
      }
    } catch {
      // 跳过不完整分片
    }
  };

  const drain = async function* () {
    while (queue.length) yield queue.shift()!;
  };

  for await (const raw of chunks) {
    buf += raw;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
      yield* drain();
      if (finished) break;
    }
    yield* drain();
    if (finished) break;
  }
  // 处理残留（最后一个无换行结尾的分片，可能含 [DONE]）
  if (buf.length > 0) {
    handleLine(buf);
    yield* drain();
  }

  // 流结束后，按完整累积参数逐个 emit 工具调用；解析失败必须显式报错（审查项 2）
  for (const tc of tcBuf) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.args || '{}');
    } catch {
      throw new Error(`openai tool_call ${tc.name || tc.id} 参数不是合法 JSON: ${tc.args}`);
    }
    yield { type: 'tool_call', id: tc.id || crypto.randomUUID(), toolId: tc.name, args };
  }
  yield { type: 'done', finishReason: 'stop' };
}

export class OpenAIAdapter implements ModelAdapter {
  readonly provider = 'openai';
  constructor(private cfg: OpenAIConfig) {}
  get model(): string {
    return this.cfg.model;
  }

  async *chat(req: ModelRequest): AsyncIterable<ModelEvent> {
    const body = {
      model: this.cfg.model,
      stream: true,
      messages: toOpenAIMessages(req.messages),
      tools: req.tools.map((t: ModelToolSpec) => ({
        type: 'function',
        function: { name: t.id, description: t.description, parameters: t.parameters },
      })),
    };
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`openai http ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    async function* readChunks() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    }
    yield* parseOpenAIChatStream(readChunks());
  }
}
