# 验证报告 v1

- 日期：2026-11-01
- 环境：Windows 11 (win32) / Node v22.22.2 / npm 10.9.7 / tsx 4.x / typescript 5.x / node:sqlite（实验特性）/ Git（初始化于 `main` 分支）
- 结论标记规则（任务书 六）：**通过 / 失败 / 阻塞 / 未验证**。提供接口或模拟实现 ≠ 真实接入通过。
- 证据位置：`validation/validation-output.log`（运行结果）、`src/**`（源码）、`validation/**/*.test.ts`（验证脚本）。

---

## 0. 验收总览

| 项目 | 验收门槛 | 结论 | 关键证据 |
|------|----------|------|----------|
| 架构边界 | 模型与工具适配器不侵入核心业务 | **通过** | interfaces-v1 / B1+B5 |
| 模型 | 两个服务商复用同一流程 + 真实调用证据 | **未验证** | 编排/契约 通过；真实调用无凭据→未验证 |
| 终端 | 启动/输出/取消/退出/进程回收可复现 | **通过** | C1–C3 |
| 构建 | 至少一种真实 STM32 工具链完成样例构建 | **阻塞** | C4 命令构造通过；C5 真实构建阻塞 |
| 飞书 | 接入路径明确；有授权时完成真实读取 | **阻塞** | 路径明确；本轮无授权，未读取 |
| EDA | 证据支持的兼容性结论与边界 | **通过** | 官方文档引用（见 §E） |
| 恢复 | 异常后状态明确，避免静默丢失/重复副作用 | **通过** | F1–F5 |
| 凭据 | 前端/日志/仓库/交付材料无真实密钥 | **通过** | .gitignore / B5 / 代码扫描 |

> 汇总：通过 5、未验证 1、阻塞 2、失败 0。
> 二轮复验 7 项强制整改已完成（§0.2）；第三轮复验 3 项缺口也已修复并补测（§0.3）。当前验证套件合计 **36 通过 / 2 跳过（C5 真实构建阻塞、F12 联接越界环境禁建联接）/ 0 失败**。

---

## 0.1 评审整改说明（针对审查提出的 6 项问题，第二轮）

审查结论：「架构方向可保留，但需先修复 6 项缺陷再进入整体验收；先完成无需外部资源的修复」。本轮已逐项修复并补充回归测试（共 22 项，21 通过 / 1 跳过）。

| # | 审查问题 | 修复 | 证据 |
|---|----------|------|------|
| 1 | 工具调用历史失控，多调用互相覆盖 | `ModelGateway` 改为每轮收集**所有** `tool_call` 并逐个执行、各自回灌结果；提取 `toOpenAIMessages`/`toAnthropicMessages` 纯函数单测 | `src/model/gateway.ts`、`B6`/`B7`/`B8` |
| 2 | OpenAI 工具参数被丢弃（片段转 `{}`） | `OpenAIAdapter` 按 `tool_call` 索引累积 arguments 片段，流结束后整体解析；解析失败**显式报错** | `src/model/openai-adapter.ts`、`B7` |
| 3 | 文件保护验证真实性存疑（仅元数据） | `writeAssetGuarded` **真实落盘**到工程根，覆盖前比对磁盘实际内容哈希；外部修改冲突且无 `force` → 拒绝 | `src/core/task-engine.ts`、`F4` |
| 4 | 恢复未推导具体执行节点 | `Run` 增加 `executorId`；恢复按「自身节点在线」判定等待/终止；`unknown` 保留不盲目判定 | `src/core/types.ts`、`src/core/persistence.ts`、`src/core/task-engine.ts`、`F6` |
| 5 | 终端仅验证最短子进程 | 补充并发隔离、完整交互链、kill 后回收且 PID 不再存活；`terminal-executor` 加固（exit/close 双保险）+ 独立执行服务方案说明 | `src/tools/terminal-executor.ts`、`C6`/`C7`/`C8` |
| 6 | 读取工具拼接校验可被 `..`/符号链接越界 | `ReadFileTool` 改用 `fs.realpathSync` 规范化后 containment 校验，并补越界测试 | `src/tools/read-file-tool.ts`、`B9` |

整改后仍保持的结论：真实模型调用（B 真实 API）、真实 STM32 构建（C5）、飞书真实读取（D）因**无凭据/无工具链/无授权**仍为 未验证/阻塞，未以模拟充当通过。

---

## 0.2 第二轮复验 7 项强制整改（问题 → 修复位置 → 测试证据）

复验结论原文：「仍需整改，暂不进入 UI 开发」。以下 7 项均已修复、补测，并**未推进 UI / 外部接入 / 部署**。

| # | 复验发现的问题 | 修复位置 | 测试证据 |
|---|----------------|----------|----------|
| 1 | 统一消息结构未保存 assistant 发起的工具调用；第二轮请求只映射 tool 结果，丢失「谁发起调用」，OpenAI/Claude 会拒绝（要求 tool 前有对应 assistant 调用） | `src/model/adapter.ts`：`ChatMessage` 改为判别联合类型，新增 `ToolCallRecord`；`assistant` 消息可携带 `toolCalls`。`src/model/gateway.ts`：回灌结果前先把携带 `toolCalls` 的 assistant 消息推入历史 | `B7`/`B8`（两适配器正确渲染 `assistant.tool_calls`/`tool_use`）；`B10`（ProbeAdapter 断言第二轮请求保留 `assistant+toolCalls` 且「调用↔结果」配对正确） |
| 2 | 文件写入未校验工程边界（含 `..`/目录联接）；未区分新建/修改/外部删除/未登记已有；无显式预期版本；冲突会静默覆盖 | `src/core/task-engine.ts` `writeAssetGuarded`：边界双校验（解析绝对路径 + 父目录 `realpath` 规范化捕获联接越界）；四路冲突区分；以已登记资产 `contentHash` 作显式预期版本，磁盘哈希不符且无 `force` → 抛 `RefuseOverwriteError`，绝不静默覆盖 | `F4`（外部修改拒绝、force 可覆盖）；`F8`（边界 `..`/`..\`/绝对越界拒绝）；`F9`（未登记同名文件拒绝）；`F10`（已登记被外部删除拒绝重建） |
| 3 | 子进程默认继承服务进程全部环境变量，凭据/标记有泄漏风险 | `src/tools/terminal-executor.ts`：新增 `DEFAULT_ENV_WHITELIST`（PATH/SystemRoot/ComSpec/TEMP/HOME…），`buildEnv` 仅透传白名单 ∪ 调用方显式变量；POSIX 下 `detached` 启用进程组、Windows 保持非 detached 以保证 `taskkill /T` 递归回收后代 | `C9`（虚拟服务标记不可见、白名单 PATH 可见、显式变量可见） |
| 4 | 恢复未按「原执行节点」对账；取消请求与已确认取消未分离；结果不明时可能盲目判定或静默取消 | `recoverOnStartup` 仅依据 `run.executorId` 是否在本节点在线集合判定；新增 `RunStatus.cancel_requested` + `Run.cancelRequested`；`requestCancel`（置 `cancel_requested`）与 `confirmCancel`（置 `cancelled`）分离；离线无取消请求的普通任务与 `unknown` 一律保留，绝不静默取消 | `F3`（自身节点在线→等待；离线无取消请求→`unknown` 而非 `cancelled`）；`F6`（场景 A–E 全覆盖）；`F7`（`requestCancel`≠`confirmCancel`） |
| 5 | 缺少真正的后代进程清理测试；未区分「进程退出」与「输出排空」 | `C10` 用真实「父 spawn 孙」进程树，kill 父后验证孙停止写入（断言**击杀延迟排空后日志不再增长**，而非简单比总行数，规避击杀延迟误判）；`C11` 验证 `wait()` 仅在 stdio `close`（输出排空）后结算，不提前于 `exit` | `C10`（连测稳定通过）；`C11`（5000 字节输出完整） |
| 6 | 缺少针对工具参数跨 SSE 分片累积与无效参数的直接测试 | 纯函数解析器 `parseOpenAIChatStream`/`parseClaudeChatStream` 按 `tool_call` 索引累积 arguments 片段、流结束整体解析、非法 JSON 显式抛错；新增 `B11`–`B14` 直接喂入分片 SSE 与非法参数 | `B11`/`B12`（OpenAI 跨分片累积为合法 JSON / 非法参数显式抛错）；`B13`/`B14`（Claude 同等） |
| 7 | 需逐项关联「问题→修复位置→测试证据」；暂不推进 UI/外部接入/部署 | 本 §0.2 即交付物；所有改动均在 `src/` 与 `validation/`，**无 UI / 外部接入 / 部署改动** | 本报告 §0.2 七行映射表；代码改动可经 `git diff` 核验 |

> 复验整改后整体回归：B 14/0、C 10/1 跳过（C5）、F 10/0，合计 **34 通过 / 1 跳过 / 0 失败**。C10 原为历史 blocker，根因是测试断言用「总行数相等」误判击杀延迟，已改为「击杀后日志停止增长」断言，现稳定通过。

---

## 0.3 第三轮复验 3 项缺口整改（执行方通过 / 评审方未复现）

复验结论：「基础方案保留，本轮整改尚未验收通过；还剩三项必须收尾」。以下三项已修复并补测；其中**联接越界用例因当前环境禁止创建符号链接/联接而 skip**（与评审说明「当前环境禁止创建联接，未能实测」一致），已明确标注「评审方未复现」，代码路径仍由合法路径用例覆盖。

| # | 缺口（评审定位） | 修复位置 | 测试证据 | 状态 |
|---|------------------|----------|----------|------|
| 1 | 文件写入边界只查直接父目录；父目录不存在时跳过 realpath，漏掉上层目录联接 | `src/core/task-engine.ts` `writeAssetGuarded`：边界改为**从目标路径向上走到最近已存在祖先**并 `realpath` 校验在根内；目标文件自身存在也 `realpath` 校验；**任何路径检查失败均 fail-closed（不得放行）** | `F8`（`..`/`..\`/绝对越界）、`F12`（合法嵌套路径被接受；若环境允许创建符号链接则联接越界被拒，否则 **skip 标注评审方未复现**） | 执行方通过；评审方未复现（环境禁建联接） |
| 2 | 修改版本保护用 DB 最新哈希，没接收「生成修改时的预期版本」，旧修改可能覆盖新已登记版本 | `writeAssetGuarded` 的 `opts` 增加 `expectedHash`；已登记文件时若提供了 `expectedHash` 且 ≠ 当前已登记 `contentHash`，无 `force` → 抛 `RefuseOverwriteError`（乐观并发） | `F11`（基于旧版本 H0 的修改被拒；正常修改可写；`force` 可覆盖） | 执行方通过 |
| 3 | `terminateWaiting` 仍能无证据把离线任务标 `cancelled` | `recoverOnStartup` 移除 `terminateWaiting→cancelled` 自动转态；无执行端停止证据时**保留 `cancel_requested` 状态**并归入 `report.pendingCancel`；终态 `cancelled` 只能由执行端 `confirmCancel()` 进入。`RecoverReport` 增加 `pendingCancel` 字段 | `F6 场景 C`（`terminateWaiting` 不再→`cancelled`，改为保留请求态+`pendingCancel`）、`F7`（恢复保持请求态）、`F13`（确认取消才终态） | 执行方通过 |

> 第三轮复验 5 条执行指令落实情况：① 终端测试加有界超时（`boundedWait` 默认 20s，超时即 kill+报错）与失败清理（`withTerm` 统一 `finally` kill+回收）+ 启动/退出诊断日志（C1–C11、C6/C9 多进程亦补清理）→ `validation/C-terminal/terminal.test.ts`；② 写入校验覆盖最近已存在祖先及目标文件链接、检查失败不放行 → 见缺口 1；③ 写入接口接收 `expectedHash` + 回归测试 → 见缺口 2（F11）；④ 恢复不得代替执行停止确认 → 见缺口 3；⑤ 更新本报告（§0.3，区分执行方通过与评审方未复现）并形成本地 Git 提交，**暂不推进 UI / 外部接入 / 部署**。
>
> 第三轮整改后整体回归：B 14/0、C 10/1 跳过（C5）、F 12/1 跳过（F12 联接越界，环境禁建联接），合计 **36 通过 / 2 跳过 / 0 失败**；`tsc --noEmit` 通过。

---

## 1. 架构边界 — 通过

- 环境与版本：同上。
- 复现：`src/model/*`（适配器）、`src/tools/*`（工具插件）、`src/core/*`+`src/app/*`（业务）分层；`ModelGateway` 只依赖 `ModelAdapter`/`Tool` 接口。
- 预期：模型/工具变更不影响核心业务。
- 实际：B1 用 MockAdapter 跑通同一编排；B5 证明 `OpenAIAdapter`/`ClaudeAdapter` 仅实现接口，网关不感知服务商。
- 证据：`src/model/gateway.ts`、`validation/B-multimodel/contract.test.ts` (ok 1,5)。
- 结论：**通过**。
- 限制：仅验证接口隔离，未做端到端多 Agent 编排。

## 2. 模型 — 未验证（真实调用）

- 环境与版本：同上；无 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` 等真实凭据。
- 复现：`npm run validate:contract` → B1 编排（输入→工具调用→程序执行只读工具→回灌→模型回答）通过；B2 流式增量通过；B3 错误转换通过；B4 `AbortSignal` 透传 fetch（适配器层取消机制）通过；B5 双服务商同接口、无凭据不注册真实适配器。
- 预期：两个服务商真实 API 走同一流程并产出真实回答。
- 实际：仅 Mock 证明流程与契约；真实 API 调用因无凭据未执行。
- 证据：`validation/B-multimodel/contract.test.ts` (ok 1–5)；`src/model/openai-adapter.ts`、`src/model/claude-adapter.ts`（契约实现，含流式 SSE 解析，未联网验证）。
- 结论：**未验证**（真实调用）。编排/契约为 通过。
- 限制：流式输出/超时/取消/错误转换的真实 API 行为需凭据后补测；B4 仅证明取消信号已透传至 fetch 层。

## 3. 终端 — 通过

- 环境与版本：同上；`node:child_process` 真实进程；Windows 下通过 `taskkill /T` 整树回收，POSIX 下通过进程组 `kill(-pgid)`。
- 复现：`npm run validate:term` →
  - C1 指定工作目录启动、实时接收 stdout/stderr、退出码 0、进程回收：通过。
  - C2 交互输入 `ping` → 回显 `echo:ping`：通过。
  - C3 `kill()` 停止、进程回收、`isAlive()===false`：通过。
  - C6 并发终端各自输出不串台：通过。
  - C7 完整交互链多行输入逐行回显：通过。
  - C8 kill 后回收且 PID 不再存活：通过。
  - C9 子进程环境隔离（白名单 + 显式变量可见，服务私有标记不可见）：通过。
  - C10 后代进程清理：kill 父进程后孙进程停止写入（真实进程树，击杀延迟排空后日志不再增长）：通过。
  - C11 输出排空：`wait()` 在 stdio `close`（输出全部就绪）后才结算，不提前于 `exit`：通过。
- 预期：启动/输出/取消/退出/回收、环境隔离、后代清理可复现。
- 实际：全部复现。
- 证据：`validation/C-terminal/terminal.test.ts` (ok 1–11，C5 跳过)；`src/tools/terminal-executor.ts`。
- 结论：**通过**。
- 限制：跨平台信号语义（Windows SIGTERM 映射）已在断言中做兼容处理，未在全平台矩阵验证。

## 4. 构建 — 阻塞（真实 STM32 构建）

- 环境与版本：探测到 `C:/Program Files (x86)/STMicroelectronics` 仅含 `stlink_server`；**无 Keil、无可用 STM32CubeIDE CLI、无 `arm-none-eabi-gcc`/`make`、无样例工程**。
- 复现：
  - C4 无头构建命令构造：Keil `UV4.exe -b <uvprojx> -j0 -o build_log.txt`；CubeIDE `stm32cubeide.exe -nosplash -application org.eclipse.cdt.managedbuilder.core.headlessbuild -data <ws> -build <target>`：通过。
  - C5 真实构建：因工具链/样例缺失 → `t.skip`（阻塞）。
- 预期：至少一种真实工具链完成样例构建并取退出状态/日志/产物。
- 实际：未执行（环境不满足）。
- 证据：`src/build/stm32-build.ts`、`validation/C-terminal/terminal.test.ts` (ok 9; C5 skipped)。
- 结论：**阻塞**（命令构造 通过，真实构建 阻塞）。
- 限制：需安装 Keil 或 STM32CubeIDE 并提供隔离样例工程后补真实构建；本轮不擅自构建/烧录用户工程（任务书 七）。

## 5. 飞书 — 阻塞（本轮无授权，未读取）

- 调研来源（官方）：
  - 飞书开放平台首页：https://open.feishu.cn/ （含 Lark CLI `npx @larksuite/cli@latest install`，MIT，可把 AI agent 接入飞书 12 大领域）
  - OAuth 登录授权与 `user_access_token`：https://open.feishu.cn/document/ukTMukTMukTM/uETOwYjLxkDM24SM5AjN
  - 云文档接入总览（tenant/user_access_token 访问自有/非自有资源）：https://feishu.apifox.cn/doc-401300
  - 获取 `user_access_token`：https://feishu.apifox.cn/api-58160393
- 个人使用授权方式与权限要求（调研结论）：
  1. 个人使用需先创建「团队/企业」（免费），在其下创建**企业自建应用**，获得 `app_id`/`app_secret`。
  2. 配置重定向 URL（如 `https://127.0.0.1`），申请所需权限范围（读文档需 `docx` 相关 scope）。
  3. 走 OAuth：用户访问 `authorize` → 登录授权得 `code` → 后端用 `code` 换 `user_access_token`+`refresh_token`（code 5 分钟有效、单次）。
  4. 读用户自有文档用 `user_access_token` 调用 Docx API；读他人文档需该文档「添加文档应用」授权。
  5. 可选更轻量路径：Lark CLI 直接把 agent 接入飞书（IM/Drive/Base 等），但读指定私有文档仍需相应授权。
- 复现（本轮）：仅完成官方资料查阅与接入路径梳理；**未发送消息、未写入真实文档**（任务书 D）。
- 预期：有授权时读取指定测试文档并保留来源引用；验证授权失效处理。
- 实际：无授权条件，未做真实读取；缺失权限时阻塞。
- 结论：**阻塞**（接入路径已明确；真实读取待授权）。
- 限制/阻塞原因：需用户创建飞书应用并提供 `app_id`/`app_secret` 与一次用户授权；`Connection` 仅存 `configRef` 引用，不落明文（约束 9）。
- 授权失效处理（设计）：`Connection.status` 置 `expired`，用 `refresh_token` 刷新；刷新失败提示重新授权，不静默重试。

## 6. EDA（嘉立创 EDA 专业版）— 通过（证据支持，边界清晰）

- 调研来源（官方）：
  - 嘉立创 EDA 专业版：https://pro.lceda.cn/ （基于浏览器云端设计）
  - Pro API（BETA）：`PCB_Document.importAutoLayoutJsonFile()` https://prodocs.lceda.cn/cn/api/reference/pro-api.pcb_document.importautolayoutjsonfile.html
  - 网表工具扩展（`.enet` JSON 导入导出）：https://ext.lceda.cn/item/sanby/lceda-nettools
  - 原理图 JSON 导出扩展（只读 API）：https://jlc-ext.com/item/qzzq2002/schematic-json-export
- 兼容性结论（区分 官方支持 / 实验 / 推测）：
  - **官方支持**：浏览器内运行；原理图/PCB 以 JSON 导入导出；网表 `.enet` JSON；扩展广场 JS 扩展（如 `dmt_Pcb.createPcb`、`pcb_Document.importAutoLayoutJsonFile`、原理图只读快照 API）。
  - **实验验证**：`importAutoLayoutJsonFile` 标注 **BETA**；社区/官方「原理图 JSON 导出」扩展基于只读 API，需实测保真度。
  - **推测/不支持**：未找到**独立 headless / 服务端 API 或 MCP server** 文档；故**不默认通过浏览器自动点击实现核心集成**。
- 工程读写与导入导出受支持路径：编辑器内导入/导出 JSON；网表 `.enet`；扩展读写工程图元。
- 原理图/网络/符号/封装/PCB 关联：在编辑器数据模型中以 JSON 表达（components/pins/net 等），导出扩展给出 `components/componentPins/etsByName` 等字段；外部以 JSON 解析即可关联。
- 可用自动化入口：编辑器内 JS 扩展 API（扩展广场）+ 文件导入/导出。
- 格式转换风险/许可/版本：Pro 与标准版文件不完全互通（规模/功能差异）；JSON↔Altium/KiCad 转换需实测网表/封装/坐标保真；专业版对个人永久免费，商业需留意条款；BETA API 可能变更。
- 结论：**通过**（提供证据支持的兼容性结论与边界；核心集成建议走「导出 JSON→本地解析/生成→回灌」，不依赖浏览器自动点击）。
- 限制：未做代码级 EDA 集成原型（本轮不实现完整 PCB 编辑器，任务书 七）。

## 7. 恢复 — 通过

- 环境与版本：同上；SQLite（`node:sqlite`）真实落盘。
- 复现：`npm run validate:recovery` →
  - F1 页面关闭不丢（重开连接可取回）：通过。
  - F2 重启区分 succeeded/failed/unknown：通过。
  - F3 恢复按原执行节点对账：自身节点在线→等待(`waiting_executor`)；离线无取消请求→保留 `unknown` 绝不静默取消：通过。
  - F4 文件版本变化拒绝直接覆盖（仅显式 `force` 才覆盖；真实落盘 + 哈希比对）：通过。
  - F5 有副作用不盲目自动重试：通过。
  - F6 恢复按原执行节点对账 + 取消请求/确认取消分离（场景 A–E）：通过。
  - F7 `requestCancel`≠`confirmCancel`（请求仅需标记，确认才终态）：通过。
  - F8 写入边界校验（`..`/`..\`/绝对越界拒绝）：通过。
  - F9 未登记同名文件冲突拒绝覆盖：通过。
  - F10 已登记文件被外部删除拒绝重建：通过。
- 预期：异常后状态明确，避免静默丢失或重复副作用；取消请求与已确认取消严格分离。
- 实际：F 套 10/10 通过（0 失败）。
- 证据：`validation/F-recovery/recovery.test.ts` (ok 1–10)；`src/core/task-engine.ts`、`src/core/types.ts`、`src/core/persistence.ts`。
- 结论：**通过**。
- 限制：未做跨进程 Executor 心跳集群与幂等重试框架（最小恢复语义已验证）。

## 8. 凭据 — 通过

- 复现：
  - `.gitignore` 排除 `.env`、`*.log`、`db/*.sqlite`；仓库无明文密钥。
  - `src/app/service.ts`：仅当环境变量存在且非占位符才注册真实适配器（B5 验证：空 env 下 `registeredAdapters===[]`）。
  - `Connection.configRef` 仅存引用；真实密钥在环境变量/密钥库，不落 `assets`/日志。
  - 交付材料中所有密钥为 `__REPLACE_ME__` 占位（见 `.env.example`）。
- 预期：前端/日志/仓库/交付材料无真实密钥。
- 实际：满足。
- 证据：`.gitignore`、`.env.example`、`src/app/service.ts`、`validation/B-multimodel/contract.test.ts` (ok 5)。
- 结论：**通过**。
- 限制：远程部署建议接入系统密钥库并加 CI 密钥扫描（见 risks-and-decisions.md §4）。

---

## 9. 后续补齐项（依赖顺序）

1. 取得模型凭据 → 补 B 真实双服务商调用（含流式/超时/取消/错误转换）。
2. 安装 Keil 或 STM32CubeIDE + 隔离样例工程 → 补 C5 真实构建（取退出码/日志/产物）。
3. 创建飞书应用并取得一次用户授权 → 补 D 真实读取 + 失效刷新。
4. 评估并（可选）自研 EDA 扩展原型 → 验证 JSON 导入导出回灌保真度。
5. 远程部署：SQLite→Postgres 迁移、`Executor/Connector` 拆分为常驻服务、桌面壳（Tauri/Electron）评估。
