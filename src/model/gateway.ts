import type { ModelAdapter, ModelRequest, ModelEvent, ChatMessage, ModelToolSpec } from './adapter.js';
import type { Tool, ToolExecResult } from '../tools/tool.js';

// 模型网关 / 工具调度（架构基线：模型网关／工具调度层）。
// 职责：驱动「输入→模型提出调用→程序执行→回灌结果→模型回答」的同一任务流程，
// 两个不同服务商复用同一编排（任务B 验收点）。

export type GatewayEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolId: string; result: ToolExecResult }
  | { type: 'error'; message: string };

export interface GatewayDeps {
  adapters: Map<string, ModelAdapter>;
  tools: Map<string, Tool>;
}

export interface RunConversationOptions {
  cwd?: string;
  // 显式批准的副作用工具（只读工具自动批准；其余默认拒绝，约束4）
  approvedSideEffectTools?: Set<string>;
  maxTurns?: number;
}

export interface RunResult {
  answer: string;
  turns: number;
  toolCalls: number;
}

export class ModelGateway {
  constructor(private deps: GatewayDeps) {}

  private toolSpecs(): ModelToolSpec[] {
    return [...this.deps.tools.values()].map((t) => ({
      id: t.id,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async runConversation(
    input: string,
    adapterId: string,
    onEvent: (e: GatewayEvent) => void,
    opts: RunConversationOptions = {}
  ): Promise<RunResult> {
    const adapter = this.deps.adapters.get(adapterId);
    if (!adapter) throw new Error(`adapter not found: ${adapterId}`);
    const cwd = opts.cwd ?? process.cwd();
    const approved = opts.approvedSideEffectTools ?? new Set<string>();
    const maxTurns = opts.maxTurns ?? 8;

    const messages: ChatMessage[] = [{ role: 'user', content: input }];
    const toolSpecs = this.toolSpecs();
    let answer = '';
    let toolCalls = 0;
    let lastTurn = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      lastTurn = turn;
      const req: ModelRequest = { messages, tools: toolSpecs, stream: true };
      // 收集本轮所有工具调用（审查项 1：支持一多对调用，不互相覆盖）
      const pendingCalls: Array<{ id: string; toolId: string; args: Record<string, unknown> }> = [];
      let textBuf = '';

      for await (const ev of adapter.chat(req)) {
        if (ev.type === 'text') {
          textBuf += ev.delta;
          onEvent({ type: 'text', delta: ev.delta });
        } else if (ev.type === 'tool_call') {
          pendingCalls.push({ id: ev.id, toolId: ev.toolId, args: ev.args });
          onEvent({ type: 'tool_call', toolId: ev.toolId, args: ev.args });
        }
        // 'done' 由循环退出处理
      }

      if (pendingCalls.length > 0) {
        // 审查项 1：先把「模型发起调用的 assistant 消息」完整保留到历史，
        // 再回灌每个工具结果。否则第二轮请求只有 user/tool，缺少 assistant(tool_calls)，
        // OpenAI/Claude 会拒绝（要求 tool 消息前有对应的 assistant 调用记录）。
        messages.push({
          role: 'assistant',
          content: textBuf,
          toolCalls: pendingCalls.map((c) => ({ id: c.id, toolId: c.toolId, args: c.args })),
        });
        // 逐个执行并各自回灌结果，保持「调用↔结果」对应（审查项 1）
        for (const call of pendingCalls) {
          toolCalls++;
          const tool = this.deps.tools.get(call.toolId);
          if (!tool) {
            messages.push({
              role: 'tool',
              toolName: call.toolId,
              toolCallId: call.id,
              content: JSON.stringify({ ok: false, error: 'unknown tool' }),
            });
            continue;
          }
          // 程序执行层决定权限（约束4）
          const allow = tool.readOnly || approved.has(tool.id);
          if (!allow) {
            const result: ToolExecResult = { ok: false, error: 'not authorized: side-effect tool requires explicit approval' };
            onEvent({ type: 'tool_result', toolId: tool.id, result });
            messages.push({ role: 'tool', toolName: tool.id, toolCallId: call.id, content: JSON.stringify(result) });
            continue;
          }
          const result = await tool.execute(call.args, { cwd });
          onEvent({ type: 'tool_result', toolId: tool.id, result });
          messages.push({ role: 'tool', toolName: tool.id, toolCallId: call.id, content: JSON.stringify(result) });
        }
        continue; // 回灌结果，进入下一轮让模型作答
      }

      answer = textBuf;
      break;
    }

    return { answer, turns: lastTurn + 1, toolCalls };
  }
}
