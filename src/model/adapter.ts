// 可替换 AI 运行时：模型适配器最小接口（架构基线 约束2）。
// 关键约束4：适配器只负责「提出」工具调用（tool_call 事件），绝不自行执行。
// 程序执行层收到事件后，按权限执行并把结果回灌。

// 一次「模型提出工具调用」的记录：网关在回灌结果前必须先保存这条 assistant 消息，
// 否则送给服务商的第二轮请求会丢失「是谁发起了调用」（审查项 1：历史完整）。
export interface ToolCallRecord {
  id: string;
  toolId: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRecord[] } // 可携带模型发起的调用
  | { role: 'tool'; content: string; toolCallId: string; toolName: string }; // 调用结果（程序执行层回填）

export type ModelEvent =
  | { type: 'text'; delta: string } // 流式文本增量
  | { type: 'tool_call'; id: string; toolId: string; args: Record<string, unknown> } // 仅「提出」
  | { type: 'done'; finishReason: string }; // 结束（成功/取消/错误由调用方判定）

export interface ModelToolSpec {
  id: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ModelToolSpec[];
  stream: boolean;
  signal?: AbortSignal; // 用于超时/取消（真实网络调用时生效）
}

export interface ModelAdapter {
  readonly provider: string; // 服务商标识，如 'openai' / 'anthropic'
  readonly model: string;
  // 返回事件流；流式输出、工具调用、结束都通过事件表达
  chat(req: ModelRequest): AsyncIterable<ModelEvent>;
}
