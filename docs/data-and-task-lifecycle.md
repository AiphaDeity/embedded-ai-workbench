# 数据与任务生命周期 v1

覆盖：持久化模型、Run 状态机、最小任务恢复（验证 F）、会话/任务不依赖页面或进程存活、版本策略与导出/备份/恢复（约束 6）。

---

## 1. 持久化模型

- 存储：SQLite（本轮用 Node 内置 `node:sqlite`，零额外依赖；未来可换 Postgres，接口不变）。
- 位置：`./db/workstation.sqlite`（`WORKSTATION_DB_PATH` 可配），WAL 模式，落到本地文件，便于备份与迁移。
- 实体表：`projects / assets / sessions / runs / steps / tool_calls / artifacts / connections / executors`（见 `src/core/persistence.ts`）。
- 每个实体带 `schemaVersion`；迁移以增量 SQL 追加，不破坏旧数据。

## 2. Run 状态机（任务单元）

```
        ┌─────────┐
        │ pending │
        └────┬────┘
             │ 启动
             ▼
        ┌─────────┐   模型提工具调用→程序执行→回灌    ┌──────────────┐
        │ running │ ───────────────────────────────▶ │ (tool loop)  │
        └────┬────┘                                  └──────┬───────┘
             │                                                  │ 继续/完成
   ┌─────────┼───────────────┬───────────────┬─────────┐      │
   ▼         ▼               ▼               ▼         ▼      ▼
┌──────┐ ┌────────┐   ┌──────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│failed│ │unknown │   │waiting_      │ │cancel_   │ │cancelled│ │succeeded│
└──────┘ └────────┘   │executor      │ │requested│ └──────────┘ └──────────┘
                      └──────────────┘ └──────────┘
```
- `unknown`：服务重启后无法判定成功/失败（如执行节点崩溃）。
- `waiting_executor`：执行节点离线，等待重连后继续。
- `cancel_requested`：已发起取消请求但执行端/操作员尚未确认（与 `cancelled` 分离，见下文）。
- `cancelled`：用户/策略显式确认终止。

## 3. 最小任务恢复（验证 F，结论：通过）

实现：`src/core/task-engine.ts`（`recoverOnStartup` / `writeAssetGuarded` / `shouldRetry` / `requestCancel` / `confirmCancel`）。验证脚本：`validation/F-recovery/recovery.test.ts`（10/10 项通过，0 失败；真实 STM32 构建阻塞在终端套件 C5，不在本套）。

| 要求 | 实现与证据 | 结论 |
|------|-----------|------|
| 页面关闭不丢任务 | 关闭连接后，以**同一文件**重开 `WorkstationStore`，`getRun` 仍可取回（F1） | 通过 |
| 重启后区分成功/失败/未知 | `recoverOnStartup` 对账：succeeded/failed 保持，running/waiting 在无在线节点时置 `unknown`（F2） | 通过 |
| 执行节点离线可等待或终止 | Run 关联 `executorId`；自身节点在线→`waiting_executor`（等待，绝不终止）；`terminateWaiting` 仅对离线/无关联节点生效→`cancelled`；`unknown` 状态保留不盲目判定（F3/F6） | 通过 |
| 恢复按「原执行节点」对账 | `recoverOnStartup` 仅依据 `run.executorId` 是否在本节点在线集合判定，不依赖其他节点（F6 场景 A–E） | 通过 |
| 取消请求 ≠ 已确认取消 | 新增 `RunStatus.cancel_requested` + `Run.cancelRequested`；`requestCancel` 仅置请求态，`confirmCancel` 才进入 `cancelled`；离线无确认绝不静默取消（F7） | 通过 |
| 文件边界 + 祖先/目标联接校验 | `writeAssetGuarded`：① `..`/绝对越界直接拒；② 从目标路径向上走到**最近已存在祖先**并 `realpath` 校验在根内；③ 目标文件自身存在也 `realpath` 校验；**任何路径检查失败均 fail-closed 不放行**（修复：父目录不存在不再跳过检查，捕获上层目录联接）（F8/F12） | 通过（F12 联接越界用例因环境禁建联接而 skip，评审方未复现） |
| 修改版本保护（乐观并发 `expectedHash`） | `writeAssetGuarded` 的 `opts` 增加 `expectedHash`：已登记文件时若提供 `expectedHash` 且 ≠ 当前已登记 `contentHash`，无 `force` → 抛 `RefuseOverwriteError`，防止「旧修改覆盖新已登记版本」（F11） | 通过 |
| 取消请求 ≠ 已确认取消（恢复不得代替执行停止确认） | `recoverOnStartup` 移除 `terminateWaiting→cancelled` 自动转态；无执行端停止证据时**保留 `cancel_requested` 状态**并归入 `report.pendingCancel`；终态 `cancelled` 仅由执行端 `confirmCancel()` 进入（F6 场景 C / F7 / F13） | 通过 |
| 有副作用不盲目自动重试 | `shouldRetry`：有副作用即使 `autoRetry` 也返回 false；无副作用且 attempt<max 才重试（F5） | 通过 |
| 后代进程清理 / 输出排空 | 终端层 `killTree`（Windows `taskkill /T`、POSIX 进程组）整树回收后代；`wait()` 仅在 stdio `close`（输出排空）后结算（终端 C10/C11，非本套但同引擎） | 通过 |

## 4. 会话/任务不依赖页面或进程存活（约束 5）

- 所有 Session/Run/Step/ToolCall/Artifact 入库；前端仅通过 id 拉取。
- 即使 UI 关闭、App Service 重启，任务状态与产物仍在 SQLite 中（F1/F2 已证明）。

## 5. 数据与协议版本策略

- 实体 `schemaVersion`（当前 `SCHEMA_VERSION=1`）。
- 迁移：`persistence.ts` 中 `MIGRATION` 以 `CREATE TABLE IF NOT EXISTS` 起步；后续以独立 `migrate_002.sql` 递增，旧数据可导出备份。
- 模型/工具接口变更由适配器吸收，核心契约稳定（见 interfaces-v1.md §6）。
- 对外 API 建议 `X-API-Version`；破坏性变更走 v2。

## 6. 导出 / 备份 / 恢复（约束 6）

- 工程文件保留**原始格式**，存于 `Project.rootPath`，不转成内部专有格式。
- Asset 记录 `contentHash` 与 `size`，支持：
  - 导出：复制原始文件 + 元数据（`meta`）即可迁移。
  - 备份：SQLite 单文件 + 工程目录整体打包。
  - 恢复：用 `writeAssetGuarded(..., {force})` 仅在显式确认下覆盖，避免静默覆盖导致的版本丢失（F4）。
- 凭据绝不随备份落盘（约束 9）：`Connection.configRef` 只存引用，真实密钥在环境变量/密钥库。

## 7. 限制与后续

- 本轮未做分布式调度、幂等重试框架、跨进程 Executor 心跳集群——仅最小恢复语义。
- 远程部署时 SQLite→Postgres 的迁移需补充迁移脚本与连接池（见 risks-and-decisions.md）。
