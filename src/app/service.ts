import { openStore, WorkstationStore, type Store } from '../core/persistence.js';
import { TaskEngine } from '../core/task-engine.js';
import { ModelGateway } from '../model/gateway.js';
import { OpenAIAdapter } from '../model/openai-adapter.js';
import { ClaudeAdapter } from '../model/claude-adapter.js';
import { ReadFileTool } from '../tools/read-file-tool.js';
import { LocalTerminal } from '../tools/terminal-executor.js';
import type { ModelAdapter } from '../model/adapter.js';
import type { Tool } from '../tools/tool.js';

// 应用服务组合根：装配存储、模型适配器、工具与网关（架构基线：应用服务层）。
// 关键：凭据仅来自环境变量；缺失则不注册真实适配器（约束9：密钥不进前端/文件/Git）。

export interface BootstrapResult {
  store: WorkstationStore;
  gateway: ModelGateway;
  terminal: LocalTerminal;
  engine: TaskEngine;
  registeredAdapters: string[];
  shutdown(): void;
}

function envList(env: Record<string, string | undefined>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(prefix) && v != null) out[k.slice(prefix.length).toLowerCase()] = v;
  }
  return out;
}

export function bootstrap(opts: { dbPath: string; env: Record<string, string | undefined> }): BootstrapResult {
  const storeHandle: Store = openStore(opts.dbPath);
  const store = new WorkstationStore(storeHandle);

  const adapters = new Map<string, ModelAdapter>();
  const registeredAdapters: string[] = [];

  const openai = envList(opts.env, 'MODEL__OPENAI__');
  if (openai['api_key'] && openai['api_key'] !== '__REPLACE_ME__') {
    adapters.set('openai', new OpenAIAdapter({ apiKey: openai['api_key'], baseUrl: openai['base_url'] ?? 'https://api.openai.com/v1', model: openai['model'] ?? 'gpt-4o-mini' }));
    registeredAdapters.push('openai');
  }

  const claude = envList(opts.env, 'MODEL__ANTHROPIC__');
  if (claude['api_key'] && claude['api_key'] !== '__REPLACE_ME__') {
    adapters.set('anthropic', new ClaudeAdapter({ apiKey: claude['api_key'], baseUrl: claude['base_url'] ?? 'https://api.anthropic.com', model: claude['model'] ?? 'claude-sonnet-4-0' }));
    registeredAdapters.push('anthropic');
  }

  const tools = new Map<string, Tool>();
  const readFile = new ReadFileTool();
  tools.set(readFile.id, readFile);

  const gateway = new ModelGateway({ adapters, tools });
  const terminal = new LocalTerminal();
  const engine = new TaskEngine(store);

  return {
    store,
    gateway,
    terminal,
    engine,
    registeredAdapters,
    shutdown: () => storeHandle.close(),
  };
}
