# 接口与核心对象 v1

定义核心对象字段、模型/工具/执行节点的最小接口，以及 MCP 作为工具接入方式之一。
源码位置：`src/core/types.ts`、`src/model/adapter.ts`、`src/tools/tool.ts`、`src/tools/terminal-executor.ts`、`src/build/stm32-build.ts`。

---

## 1. 核心对象（Core Objects）

所有对象由工作站拥有，不绑定模型服务商数据结构（约束 1）。每个持久化实体带 `schemaVersion`。

### Project（工程）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | ProjectId | 主键 |
| name | string | 工程名 |
| kind | 'stm32' \| 'eda' \| 'doc' \| 'generic' | 工程类型 |
| rootPath | string | 本地原始文件根目录（保留原始格式，约束 6） |
| schemaVersion | number | 数据版本 |
| createdAt / updatedAt | ISODateTime | 时间戳 |
| meta | Record<string,unknown> | 扩展元数据 |

### Asset（资产）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | AssetId | 主键 |
| projectId | ProjectId | 所属工程 |
| path | string | 相对工程根路径，原始格式 |
| mime | string | 媒体类型 |
| contentHash | string | SHA-256，用于「版本变化拒绝覆盖」（任务 F） |
| size | number | 字节数 |
| schemaVersion | number | 数据版本 |
| createdAt | ISODateTime | 时间戳 |

### Session（会话）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | SessionId | 主键 |
| projectId | ProjectId | 关联工程 |
| title | string | 标题 |
| modelAdapter | ProviderId | 使用的模型适配器 |
| createdAt / updatedAt | ISODateTime | 时间戳 |

### Run（运行 / 任务单元）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | RunId | 主键 |
| sessionId / projectId | Id | 关联 |
| status | RunStatus | 见状态机（data-and-task-lifecycle.md） |
| input | string | 用户输入 |
| output? | string | 最终回答 |
| hasSideEffects | boolean | 有副作用禁止盲目重试（任务 F） |
| retryPolicy | { maxAttempts, autoRetry } | 重试策略 |
| executorId? | ExecutorId | 关联执行节点（评审整改：恢复时按自身节点在线判定等待/终止） |
| cancelRequested? | boolean | 是否已发起取消请求（与已确认取消 `cancelled` 分离，审查项 4） |
| createdAt / updatedAt | ISODateTime | 时间戳 |

RunStatus：`pending | running | succeeded | failed | unknown | cancelled | waiting_executor | cancel_requested`

> `cancel_requested`：已发起取消请求但尚未由执行端/操作员确认；恢复时保留该态等待确认，不在此静默标为 `cancelled`（见 data-and-task-lifecycle.md §2/§3）。

### Step（步骤）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | StepId | 主键 |
| runId | RunId | 所属运行 |
| index | number | 顺序 |
| kind | 'model' \| 'tool' \| 'executor' \| 'answer' | 步骤类型 |
| status | RunStatus | 状态 |
| summary / detail | string / Record | 摘要与详情 |
| startedAt? / finishedAt? | ISODateTime | 时间窗 |

### ToolCall（工具调用）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | ToolCallId | 主键 |
| stepId | StepId | 所属步骤 |
| toolId | ToolId | 工具 ID |
| args | Record<string,unknown> | 参数 |
| approved | boolean | **由程序执行层填写**（约束 4） |
| executed | boolean | 是否已执行 |
| result? | ToolResult | 执行结果 |
| error? | string | 错误 |

### Artifact（产物）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | ArtifactId | 主键 |
| runId / projectId | Id | 关联 |
| type | 'text' \| 'file' \| 'log' \| 'build-output' | 类型 |
| ref | string | 路径或引用 |
| schemaVersion | number | 数据版本 |
| createdAt | ISODateTime | 时间戳 |

### Connection（连接器，如飞书）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | ConnectionId | 主键 |
| kind | 'feishu' \| 'mcp' \| 'other' | 类型 |
| name | string | 名称 |
| configRef | string | **仅存引用**（凭据不落盘，约束 9） |
| status | 'active' \| 'expired' \| 'error' | 状态 |
| expiresAt? | ISODateTime | 凭证过期时间 |
| createdAt | ISODateTime | 时间戳 |

### Executor（执行节点）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | ExecutorId | 主键 |
| kind | 'local-terminal' \| 'stm32-build' \| 'mcp-server' | 类型 |
| endpoint | string | 本地 socket/http |
| online | boolean | 是否在线 |
| lastHeartbeat? | ISODateTime | 最近心跳 |

---

## 2. 模型最小接口（Model Adapter）

模型运行时只负责「提出」工具调用，绝不自行执行（约束 4）。源码：`src/model/adapter.ts`。

```ts
export interface ModelRequest {
  messages: ChatMessage[];
  tools: ModelToolSpec[];   // 暴露给模型的工具清单（JSON Schema）
  stream: boolean;
  signal?: AbortSignal;     // 超时/取消
}
export type ModelEvent =
  | { type: 'text'; delta: string }                                  // 流式文本
  | { type: 'tool_call'; id: string; toolId: string; args: Record<string, unknown> } // 仅「提出」
  | { type: 'done'; finishReason: string };
export interface ModelAdapter {
  readonly provider: string;   // 'openai' | 'anthropic' ...
  readonly model: string;
  chat(req: ModelRequest): AsyncIterable<ModelEvent>;
}
// 网关每轮收集本轮所有 tool_call 并逐个执行、各自回灌结果（评审整改：支持一多对调用，不互相覆盖）。
// 适配器应将累积的 arguments 片段在流结束后整体解析；解析失败必须显式报错（不静默转 {}）。
```

统一消息结构（审查项 1：历史完整）：`ChatMessage` 为判别联合类型，`assistant` 消息可携带 `ToolCallRecord[]`（模型发起的调用），`tool` 消息回填对应结果。网关在回灌结果前先把携带 `toolCalls` 的 assistant 消息推入历史，确保第二轮请求保留「谁发起了调用」，OpenAI/Claude 不再拒绝。

```ts
export interface ToolCallRecord { id: string; toolId: string; args: Record<string, unknown>; }
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRecord[] }
  | { role: 'tool'; content: string; toolCallId: string; toolName: string };
```

两个服务商适配器（`OpenAIAdapter`、`ClaudeAdapter`）实现同一接口 → 复用同一编排（验证 B）。真实调用需凭据（本轮无凭据，标记 未验证）。

---

## 3. 工具最小接口（Tool Plugin）

源码：`src/tools/tool.ts`。

```ts
export interface Tool {
  readonly id: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly readOnly: boolean;     // 只读→程序自动批准；副作用→需显式授权（约束4）
  readonly mcpExposable: boolean; // 是否可作为 MCP 工具暴露（约束8）
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecResult>;
}
export interface ToolContext { cwd: string; } // 执行层注入，工具不持凭据
export interface ToolExecResult { ok: boolean; stdout?: string; exitCode?: number; data?: unknown; error?: string; }
```

只读工具示例：`ReadFileTool`（`readOnly=true`，含目录穿越防护），已通过验证 B1/B2。

---

## 4. 执行节点最小接口（Executor / 本地终端）

源码：`src/tools/terminal-executor.ts`。本地终端与 UI 进程独立（约束 3），支持输出、输入、停止与回收（验证 C）。

```ts
export interface TerminalHandle {
  pid: number;
  onData(cb: (chunk: string) => void): void;
  onError(cb: (err: Error) => void): void;
  write(input: string): void;   // 交互输入
  end(): void;                  // 关闭 stdin（EOF）
  kill(signal?: NodeJS.Signals | number): void; // 停止
  wait(): Promise<{ exitCode: number | null; signal: string | null }>; // 进程回收
  isAlive(): boolean;
}
export class LocalTerminal { spawn(opts: SpawnOptions): TerminalHandle }
```

STM32 构建命令构造（真实构建本轮阻塞）：`src/build/stm32-build.ts` 的 `keilBuildCommand` / `cubeideBuildCommand`，分别生成 UV4 `-b` 与 `stm32cubeide -application org.eclipse.cdt.managedbuilder.core.headlessbuild` 无头命令。

---

## 5. MCP 作为工具接入方式之一（约束 8）

MCP server 暴露的工具与 `Tool` 接口同构（id/description/JSON Schema/execute）。接入方式：

```
[MCP Server] ──stdio/HTTP──▶ [McpToolAdapter] 实现 Tool 接口 ──▶ ModelGateway
```
- `mcpExposable=true` 的工具可被暴露给外部 MCP client；模型侧把 MCP 工具加入 `ModelToolSpec`。
- 权限仍由 `ModelGateway` 统一裁决（只读自动批准，副作用显式授权），MCP 不绕过约束 4。

---

## 6. 接口版本策略
- 模型/工具接口变更通过新增适配器/插件吸收，核心 `ModelGateway` 与 `Tool` 契约保持稳定。
- 实体 `schemaVersion` 随迁移递增；旧版数据可导出备份（约束 6）。
- 对外 API 建议带 `X-API-Version`，破坏性变更走 v2，不影响本地存储。
