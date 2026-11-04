// 核心领域对象 —— 工作站拥有这些数据结构，不绑定任何模型服务商（架构基线 约束1）
// 所有实体都带 schemaVersion，用于数据与协议版本策略（架构基线 + 任务F）。

export type ProviderId = string;
export type ToolId = string;
export type ModelId = string;
export type ExecutorId = string;
export type ConnectionId = string;
export type ProjectId = string;
export type AssetId = string;
export type SessionId = string;
export type RunId = string;
export type StepId = string;
export type ToolCallId = string;
export type ArtifactId = string;
export type ISODateTime = string;

export type ProjectKind = 'stm32' | 'eda' | 'doc' | 'generic';

export interface Project {
  id: ProjectId;
  name: string;
  kind: ProjectKind;
  rootPath: string; // 本地原始文件根目录（约束6：保留原始格式）
  schemaVersion: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  meta: Record<string, unknown>;
}

// 资产：保留原始文件格式；contentHash 用于「文件版本变化拒绝覆盖」（任务F）
export interface Asset {
  id: AssetId;
  projectId: ProjectId;
  path: string; // 相对工程根的路径
  mime: string;
  contentHash: string;
  size: number;
  schemaVersion: number;
  createdAt: ISODateTime;
}

// 会话：持久化，不依赖页面或单个执行进程存活（约束5）
export interface Session {
  id: SessionId;
  projectId: ProjectId;
  title: string;
  modelAdapter: ProviderId;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// 运行：一次「输入→模型→工具→模型→回答」完整流程，是任务恢复的最小单元
export type RunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown' // 重启后无法判定成功/失败（任务F）
  | 'cancelled'
  | 'waiting_executor' // 执行节点离线，等待重连（任务F）
  | 'cancel_requested'; // 已发起取消请求，但尚待执行端确认（审查项 6：取消请求 ≠ 已确认取消）

export interface RetryPolicy {
  maxAttempts: number; // 默认 1；有副作用的操作禁止盲目重试（任务F）
  autoRetry: boolean;
}

export interface Run {
  id: RunId;
  sessionId: SessionId;
  projectId: ProjectId;
  status: RunStatus;
  input: string;
  output?: string;
  hasSideEffects: boolean; // 有副作用不盲目自动重试
  retryPolicy: RetryPolicy;
  executorId?: ExecutorId; // 关联的执行节点（审查项 4：恢复时按自身执行节点判定）
  cancelRequested?: boolean; // 是否已发起取消请求（审查项 6）
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type StepKind = 'model' | 'tool' | 'executor' | 'answer';

export interface Step {
  id: StepId;
  runId: RunId;
  index: number;
  kind: StepKind;
  status: RunStatus;
  summary: string;
  detail: Record<string, unknown>;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
}

// 工具调用：模型只能「提出」，程序决定是否/如何执行（约束4）
export interface ToolCall {
  id: ToolCallId;
  stepId: StepId;
  toolId: ToolId;
  args: Record<string, unknown>;
  approved: boolean; // 由程序执行层填写
  executed: boolean;
  result?: ToolResult;
  error?: string;
}

export interface ToolResult {
  ok: boolean;
  stdout?: string;
  exitCode?: number;
  data?: unknown;
  error?: string;
}

export type ArtifactType = 'text' | 'file' | 'log' | 'build-output';

// 产物：模型/工具产出的可持久化结果
export interface Artifact {
  id: ArtifactId;
  runId: RunId;
  projectId: ProjectId;
  type: ArtifactType;
  ref: string;
  schemaVersion: number;
  createdAt: ISODateTime;
}

// 连接：应用连接器（飞书等）。凭据只存引用不存明文（约束9）
export interface Connection {
  id: ConnectionId;
  kind: 'feishu' | 'mcp' | 'other';
  name: string;
  configRef: string; // 指向密钥保险库/环境变量中的引用，不存明文
  status: 'active' | 'expired' | 'error';
  expiresAt?: ISODateTime;
  createdAt: ISODateTime;
}

// 执行节点：本地终端/构建服务，独立于网页与桌面窗口（约束3）
export interface Executor {
  id: ExecutorId;
  kind: 'local-terminal' | 'stm32-build' | 'mcp-server';
  endpoint: string; // 本地 socket / http
  online: boolean;
  lastHeartbeat?: ISODateTime;
}
