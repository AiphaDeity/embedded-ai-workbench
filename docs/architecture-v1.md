# AI 嵌入式工作站 — 架构草案 v1

- 状态：草案（待架构与验收评审）
- 范围：本轮只验证关键路径，不开发完整产品（见任务书 七）
- 基线：严格遵循任务书「三、必须遵守的架构基线」10 条约束

---

## 1. 角色与本轮目标

开发执行者依据任务书进行调研、技术验证与交付。本轮交付「架构基线 + 关键路径验证」，不实现完整 UI、不部署生产、不发布、不真实烧录、不实现完整 PCB 编辑器、不引入复杂多 Agent 系统。

## 2. 架构基线对照（10 条约束）

| # | 约束 | 本草案的落实 |
|---|------|--------------|
| 1 | 项目/会话/任务/产物由工作站拥有，不绑定模型服务商数据结构 | 核心对象（Project/Asset/Session/Run/Step/ToolCall/Artifact）定义在 `src/core/types.ts`，与任何模型服务商 schema 解耦 |
| 2 | 模型适配器、工具插件、业务模块分别设计 | 三层分离：`src/model/*`（适配器）、`src/tools/*`（工具插件）、`src/app/*`+`src/core/*`（业务/持久化） |
| 3 | 本地执行服务与网页/桌面窗口独立 | `LocalTerminal`/`Executor` 作为独立进程/服务，通过进程间通信，不依赖 UI 进程存活 |
| 4 | 模型只能提出工具调用，权限由程序执行 | `ModelAdapter` 仅产出 `tool_call` 事件；`ModelGateway` 决定批准/执行（只读自动批准，副作用需显式授权） |
| 5 | 会话和任务持久化，不依赖页面或单进程存活 | SQLite 持久化；验证 F 已证明「页面关闭不丢、服务重启可区分状态」 |
| 6 | 工程保留原始文件格式，支持导出/备份/恢复 | Asset 以原始格式存于工程根目录；`contentHash` 记录版本，支持拒绝覆盖与恢复 |
| 7 | 首版采用模块化单体，避免过早拆分微服务 | 单 Node/TS 进程内分层（modular monolith），依赖单向；远程部署时再按需拆分 |
| 8 | MCP 作为工具接入方式之一 | `Tool` 接口与 MCP 工具同构；MCP server 可包装为 `Tool`（mcpExposable=true） |
| 9 | API 密钥不得进入前端/项目文件/Git/日志 | 仅环境变量注入（`MODEL__*`），`.env` 已被 `.gitignore` 排除；`Connection` 只存 `configRef` 引用 |
| 10 | UI 默认简洁聊天，按需展开编辑区与专业面板 | 见 `ui-wireframes.md`，默认聊天，按需展开编辑器/STM32/EDA/飞书面板 |

## 3. 分层与模块（模块及依赖关系）

依赖方向严格单向：**界面 → 应用服务 → 模型运行时 → 模型网关/工具调度 → 连接器/执行节点**，核心业务不反向依赖具体适配器或工具。

```
┌──────────────────────────────────────────────────────────────┐
│ 多端界面层 (Web / Desktop / Mobile)  — React，默认简洁聊天      │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP / WS
┌───────────────────────────▼──────────────────────────────────┐
│ 应用服务层 (modular monolith, Node+TS)                         │
│  - 会话/项目/任务编排 (src/app/service.ts, src/core/task-engine)│
│  - 持久化 (src/core/persistence.ts, SQLite)                    │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ 可替换 AI 运行时 (Model Adapters)  — 仅「提出」工具调用          │
│  OpenAIAdapter / ClaudeAdapter (src/model/*)                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ 事件流 (text / tool_call / done)
┌───────────────────────────▼──────────────────────────────────┐
│ 模型网关 / 工具调度 (ModelGateway)  — 权限由程序执行             │
│  只读工具自动批准；副作用工具需显式授权                          │
└───────┬───────────────────────────────┬──────────────────────┘
        │ 执行                            │ 暴露
┌───────▼──────────┐            ┌────────▼─────────────────────┐
│ 工具插件 (Tools)  │            │ 应用连接器 / 执行节点 (Executors)│
│ fs.read 等        │            │ 飞书 / 本地终端 / STM32构建 / EDA │
│ (含 MCP 包装)     │            │ (独立进程，不随 UI 存活)          │
└──────────────────┘            └──────────────────────────────┘
```

### 模块职责与稳定性

| 模块 | 职责 | 依赖 | 稳定性 |
|------|------|------|--------|
| 界面层 | 聊天/编辑/专业面板 | 应用服务 HTTP/WS | 易变（按端迭代） |
| 应用服务 | 编排、持久化、会话/项目管理 | core、model、tools、executors | 中等 |
| core（types/persistence/task-engine） | 领域模型、存储、任务恢复 | node:sqlite | 高（长期稳定） |
| model（adapters/gateway） | 可替换 AI 运行时、工具调度 | core、tools | 适配器易变，网关接口稳定 |
| tools（插件） | 具体能力（读文件、终端等） | core | 插件各自独立演进 |
| executors/connectors | 飞书、本地终端、STM32 构建、EDA | core、tools | 外部依赖强，隔离变化 |

## 4. 部署拓扑

### 4.1 本地部署（本轮目标）
```
[Browser React] ──HTTP/WS──▶ [App Service (Node/TS, 单进程)]
                                │
                                ├── SQLite (./db/workstation.sqlite, WAL)
                                └── [Local Executor] 子进程：终端 / STM32 构建
                                     （独立存活，断线可被任务引擎感知）
模型网关 ──▶ OpenAI / Anthropic（凭据仅环境变量，进程内存）
```
- 所有数据归工作站本地；SQLite 单文件便于备份/迁移。
- 执行节点与 UI 进程解耦，满足约束 3、5。

### 4.2 未来远程部署（拓扑草案，本轮不实现）
```
[Web] [Desktop] [Mobile] ──▶ [API Gateway] ──▶ [App Service 集群]
                                          │
                                          ├── [Model Gateway] ── 多模型服务商
                                          ├── [Executor Pool]（容器/常驻）— 终端/构建/烧录
                                          ├── [Connector Svc] — 飞书/其他
                                          └── [DB] SQLite→Postgres（数据归工作站，迁移有版本策略）
```
- 关键不变式：**数据所有权在工作站**，模型网关抽象服务商，连接器外置。模块化单体先跑通，再按需把 Executor/Connector 拆为独立服务。

## 5. 核心对象（详见 interfaces-v1.md）
`Project` `Asset` `Session` `Run` `Step` `ToolCall` `Artifact` `Connection` `Executor`。

## 6. 最小接口（详见 interfaces-v1.md）
- 模型：`ModelAdapter.chat(req): AsyncIterable<ModelEvent>`
- 工具：`Tool.execute(args, ctx): Promise<ToolExecResult>`，含 `readOnly`/`mcpExposable`
- 执行节点：`spawn/ onData/ write/ end/ kill/ wait/ isAlive`

## 7. 数据与协议版本策略
- 每个核心实体带 `schemaVersion`（`persistence.ts` 中 `SCHEMA_VERSION=1`）。
- 迁移：SQLite `PRAGMA` + 增量 migration 脚本；不破坏旧数据，旧版可导出备份。
- 对外 API 增加 `X-API-Version`；模型/工具接口变更走适配器，不污染核心。
- 工程文件保留原始格式（约束 6），与内部 schema 分离，降低迁移耦合。

## 8. 尚未确定的问题及建议（提交架构评审）

1. **主工具链选型**：Keil 还是 STM32CubeIDE 作为首条贯通链路？建议先 CubeIDE（免费、CLI 文档清晰、跨平台），Keil 作备选。需用户确认。
2. **飞书个人接入形态**：个人使用需创建「团队/企业」并建自建应用，再走 OAuth `user_access_token`。建议评估「Lark CLI（`npx @larksuite/cli`）」是否比自建应用更省成本。
3. **EDA 集成深度**：专业版无 headless API，深度集成依赖编辑器内扩展 + JSON 导入导出。建议把「导出 JSON→本地解析/生成→回灌」作为主线，不依赖浏览器自动点击。
4. **桌面壳与移动端**：桌面用 Tauri（轻量、Rust 后端复用 Node 执行节点）还是 Electron？移动端 MVP 是否复用 Web。待定。
5. **多模型路由策略**：按任务/成本/能力路由，还是用户手动选？首版建议手动选 + 可配置默认。
6. **凭据保险库**：环境变量本轮够用；远程部署建议接入系统密钥库（如 OS keychain / 云服务 KMS），前端永不接触。

---
*草案结束。结论只可能在评审后标记为 通过/失败/阻塞/未验证。*
