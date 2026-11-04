// 工具插件接口（架构基线 约束2：模型适配器 / 工具插件 / 业务模块分别设计）
// 约束4：模型只能「提出」工具调用，权限由程序执行层决定。

export interface ToolContext {
  cwd: string;
  // 程序执行层注入运行上下文；工具本身不持有任何凭据
}

export interface ToolExecResult {
  ok: boolean;
  stdout?: string;
  exitCode?: number;
  data?: unknown;
  error?: string;
}

export interface Tool {
  readonly id: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  // 只读工具可被自动批准；有副作用的工具需显式授权（约束4）
  readonly readOnly: boolean;
  // 是否允许通过 MCP 暴露（约束8）
  readonly mcpExposable: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecResult>;
}
