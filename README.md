# AI 嵌入式工作站 — 架构基线与技术验证（v1 任务书）

个人使用的 AI 嵌入式工作站：先提供网页版（后续桌面/手机），主攻 STM32，支持聊天/编程/流程图/写作，以及后续原理图与 PCB 工作流。本仓库为 **架构基线 + 关键路径验证** 阶段，不实现完整产品（见任务书 七）。

## 技术基线
TypeScript + React（界面）· Node/TS 模块化单体（应用服务）· SQLite（持久化，Node 内置 `node:sqlite`）· 模型适配器可替换（OpenAI / Anthropic 兼容）· MCP 作为工具接入方式之一。

## 启动 / 测试 / 停止

> 环境要求：Node ≥ 22.5（`node:sqlite` 为实验特性），npm ≥ 10。

```bash
# 1) 安装依赖（仅 typescript / tsx / @types/node，零运行时依赖）
npm install

# 2) 类型检查（应通过，exit 0）
npm run typecheck

# 3) 运行全部验证（真实可复现）
npm run validate
#   终端验证: npm run validate:term
#   恢复验证: npm run validate:recovery
#   契约验证: npm run validate:contract

# 4) 停止：验证为一次性进程，结束后自动退出，无常驻服务需要手动停止。
#    若后续启动应用服务（未在本轮提供），用 Ctrl+C 终止，或用：
#    pkill -f "node .*"   # 仅在你明确知道在做什么时
```

- 验证结果实时写入 `validation/validation-output.log`（本地运行产物，已被 `.gitignore` 排除）。
- 真实模型调用需在 `.env` 注入 `MODEL__OPENAI__API_KEY` / `MODEL__ANTHROPIC__API_KEY`（本轮无凭据，真实调用标记 **未验证**）。

## 不含真实密钥的配置示例
复制 `.env.example` 为 `.env` 并填入；`.env` 已被 `.gitignore` 排除，永不进入 Git/前端/日志。
所有密钥在示例中均为 `__REPLACE_ME__` 占位符。凭据只经环境变量注入，运行时仅在进程内存；`Connection` 仅持久化 `configRef` 引用。

## 修改 / 新增文件清单
- 配置：`package.json`、`tsconfig.json`、`.gitignore`、`.env.example`
- 核心源码：`src/core/{types,persistence,task-engine}.ts`、`src/model/{adapter,openai-adapter,claude-adapter,gateway}.ts`、`src/tools/{tool,read-file-tool,terminal-executor}.ts`、`src/build/stm32-build.ts`、`src/app/service.ts`、`src/types/node-sqlite.d.ts`
- 验证脚本：`validation/B-multimodel/contract.test.ts`（含 `fixture/notes.txt`）、`validation/C-terminal/terminal.test.ts`、`validation/F-recovery/recovery.test.ts`
- 文档：`docs/architecture-v1.md`、`docs/interfaces-v1.md`、`docs/data-and-task-lifecycle.md`、`docs/ui-wireframes.md`、`docs/risks-and-decisions.md`、`docs/validation-report.md`

## 验收结论速览（详见 docs/validation-report.md）
| 项目 | 结论 |
|------|------|
| 架构边界 | 通过 |
| 模型（真实调用） | 未验证（编排/契约 通过） |
| 终端 | 通过 |
| 构建（真实 STM32） | 阻塞（命令构造 通过） |
| 飞书 | 阻塞（路径明确，未授权） |
| EDA（嘉立创专业版） | 通过（证据支持，边界清晰） |
| 恢复 | 通过 |
| 凭据 | 通过 |

## 后续开发任务建议（依赖顺序）
1. **模型真实调用**：取得凭据 → 补 B 真实双服务商（流式/超时/取消/错误转换）。
2. **真实 STM32 构建**：安装 Keil 或 STM32CubeIDE + 隔离样例工程 → 补 C5（退出码/日志/产物）；不擅自烧录。
3. **飞书真实读取**：创建应用 + 一次用户授权 → 补 D 真实读取与失效刷新。
4. **EDA 扩展原型**（可选）：自研只读/导入导出扩展，验证 JSON 回灌保真度。
5. **远程部署**：SQLite→Postgres 迁移；`Executor/Connector` 拆常驻服务；桌面壳（Tauri/Electron）评估。

## 实际外部资源创建 / 变更记录
- 本机：`git init` 于 `main` 分支（原目录为空、无 Git）。
- **未创建任何外部账号、未发送任何消息、未写入任何飞书/EDA 真实文档、未烧录任何设备、未部署任何服务**（严格遵循任务书 七 范围限制）。
- 所有 API 密钥均为占位符，无真实凭据进入仓库/日志/前端。

## 凭据自检结论
前端 / 日志 / 仓库 / 交付材料 **均无真实密钥**（`.gitignore` 排除 `.env`；`Connection` 仅存引用；`bootstrap` 无凭据时不注册真实适配器，见 `validation/B-multimodel/contract.test.ts` B5）。
