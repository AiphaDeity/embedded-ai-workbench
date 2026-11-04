import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelGateway, type GatewayEvent } from '../../src/model/gateway.js';
import { ReadFileTool } from '../../src/tools/read-file-tool.js';
import { OpenAIAdapter, toOpenAIMessages, parseOpenAIChatStream } from '../../src/model/openai-adapter.js';
import { ClaudeAdapter, toAnthropicMessages, parseClaudeChatStream } from '../../src/model/claude-adapter.js';
import type { ModelAdapter, ModelRequest, ModelEvent } from '../../src/model/adapter.js';

const fixtureDir = path.join(import.meta.dirname, 'fixture');

// ---- 模拟模型适配器（仅用于证明「编排流程」与「契约」，不代表真实接入） ----
class MockAdapter implements ModelAdapter {
  provider = 'mock';
  model = 'mock-1';
  async *chat(req: ModelRequest): AsyncIterable<ModelEvent> {
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === 'tool') {
      let snippet = 'NO-DATA';
      try {
        const p = JSON.parse(last.content);
        if (typeof p.data === 'string') snippet = p.data.slice(0, 12);
      } catch {
        /* ignore */
      }
      yield { type: 'text', delta: `ANSWER:${snippet}` };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    yield { type: 'tool_call', id: 'call_1', toolId: 'fs.read', args: { path: 'notes.txt' } };
  }
}

class MockStreamAdapter implements ModelAdapter {
  provider = 'mock-stream';
  model = 'mock-1';
  async *chat(req: ModelRequest): AsyncIterable<ModelEvent> {
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === 'tool') {
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    yield { type: 'text', delta: 'Hello ' };
    yield { type: 'text', delta: 'World ' };
    yield { type: 'text', delta: 'Stream' };
    yield { type: 'tool_call', id: 'c2', toolId: 'fs.read', args: { path: 'notes.txt' } };
  }
}

class ThrowingAdapter implements ModelAdapter {
  provider = 'mock-err';
  model = 'mock-1';
  async *chat(_req: ModelRequest): AsyncIterable<ModelEvent> {
    throw new Error('upstream 503');
  }
}

// ---- B1：编排流程（输入→模型提出调用→程序执行→回灌→模型回答） ----
test('B1 编排：输入→工具调用→程序执行只读工具→回灌结果→模型回答 (通过)', async () => {
  const adapters = new Map<string, ModelAdapter>([['mock', new MockAdapter()]]);
  const tools = new Map([['fs.read', new ReadFileTool()]]);
  const gw = new ModelGateway({ adapters, tools });
  const events: GatewayEvent[] = [];
  const res = await gw.runConversation('请读取 notes.txt 并总结', 'mock', (e) => events.push(e), { cwd: fixtureDir });

  assert.ok(events.some((e) => e.type === 'tool_call' && e.toolId === 'fs.read'), '应有工具调用事件');
  const tr = events.find((e) => e.type === 'tool_result') as Extract<GatewayEvent, { type: 'tool_result' }> | undefined;
  assert.ok(tr && tr.result.ok, '只读工具应被程序执行层自动批准并执行成功');
  assert.equal(res.toolCalls, 1);
  assert.ok(res.answer.startsWith('ANSWER:HELLO_WORKST'), `回答应包含工具结果片段，实际: ${res.answer}`);
});

// ---- B2：流式输出增量 ----
test('B2 流式输出增量 (通过)', async () => {
  const adapters = new Map([['mock', new MockStreamAdapter()]] as [string, ModelAdapter][]); // mock
  const tools = new Map([['fs.read', new ReadFileTool()]]);
  const gw = new ModelGateway({ adapters, tools });
  const texts: string[] = [];
  await gw.runConversation('go', 'mock', (e) => {
    if (e.type === 'text') texts.push(e.delta);
  }, { cwd: fixtureDir });
  assert.ok(texts.length >= 3, `应有多个文本增量，实际 ${texts.length}`);
  assert.equal(texts.join(''), 'Hello World Stream');
});

// ---- B3：错误转换（上游异常向上抛出，不静默吞掉） ----
test('B3 错误转换：上游异常向上抛出 (通过)', async () => {
  const adapters = new Map([['mock', new ThrowingAdapter()]] as [string, ModelAdapter][]); // mock
  const tools = new Map([['fs.read', new ReadFileTool()]]);
  const gw = new ModelGateway({ adapters, tools });
  await assert.rejects(() => gw.runConversation('x', 'mock', () => {}, { cwd: fixtureDir }), /upstream 503/);
});

// ---- B4：取消机制（AbortSignal 透传到 fetch；适配器层，真实 API 取消未验证） ----
test('B4 取消机制：AbortSignal 透传到 fetch (通过-适配器层；真实API超时/取消未验证)', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'dummy', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
  const controller = new AbortController();
  controller.abort(); // 已取消
  const iterable = adapter.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [], stream: true, signal: controller.signal });
  const iterator = iterable[Symbol.asyncIterator]();
  await assert.rejects(() => iterator.next(), /abort/i);
});

// ---- B5：双服务商复用同一接口；无凭据时不注册真实适配器（防止把模拟当通过） ----
test('B5 双服务商复用 ModelAdapter 接口；无凭据不注册真实适配器 (未验证真实调用)', async () => {
  const oa = new OpenAIAdapter({ apiKey: 'dummy', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
  const cl = new ClaudeAdapter({ apiKey: 'dummy', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-0' });
  assert.equal(typeof oa.chat, 'function');
  assert.equal(typeof cl.chat, 'function');
  assert.equal(oa.provider, 'openai');
  assert.equal(cl.provider, 'anthropic');

  const { bootstrap } = await import('../../src/app/service.js');
  const app = bootstrap({ dbPath: ':memory:', env: {} });
  assert.deepEqual(app.registeredAdapters, [], '无真实凭据时不应注册任何真实模型适配器');
  app.shutdown();
});

// ---- B6：一轮内多个工具调用不互相覆盖，且各自结果回灌（审查项 1） ----
class MockMultiAdapter implements ModelAdapter {
  provider = 'mock-multi';
  model = 'mock-1';
  async *chat(req: ModelRequest): AsyncIterable<ModelEvent> {
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === 'tool') {
      const toolMsgs = req.messages.filter((m) => m.role === 'tool');
      // 校验两个工具结果都已回灌
      const okCount = toolMsgs.filter((m) => m.content.includes('"ok":true')).length;
      yield { type: 'text', delta: `TOOLS:${toolMsgs.length}:OK:${okCount}` };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    // 第一轮提出两个工具调用
    yield { type: 'tool_call', id: 'call_a', toolId: 'fs.read', args: { path: 'notes.txt' } };
    yield { type: 'tool_call', id: 'call_b', toolId: 'fs.read', args: { path: 'notes2.txt' } };
  }
}

test('B6 一轮多个工具调用：各自执行并回灌结果 (通过)', async () => {
  const adapters = new Map([['mock', new MockMultiAdapter()]] as [string, ModelAdapter][]);
  const tools = new Map([['fs.read', new ReadFileTool()]]);
  const gw = new ModelGateway({ adapters, tools });
  const events: GatewayEvent[] = [];
  const res = await gw.runConversation('读取两个文件', 'mock', (e) => events.push(e), { cwd: fixtureDir });
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  assert.equal(toolCalls.length, 2, '应提出两个工具调用');
  const results = events.filter((e) => e.type === 'tool_result') as Extract<GatewayEvent, { type: 'tool_result' }>[];
  assert.equal(results.length, 2, '两个调用都应被程序执行');
  assert.ok(results.every((r) => r.result.ok), '两个只读工具都应成功');
  assert.ok(res.answer.startsWith('TOOLS:2:OK:2'), `回答应反映两个结果，实际: ${res.answer}`);
});

// ---- B7：OpenAI 后续请求消息映射（含 assistant tool_calls 与 tool 结果）（审查项 1） ----
test('B7 toOpenAIMessages：assistant 携带 tool_calls，tool 带 tool_call_id', () => {
  const out = toOpenAIMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', toolId: 'fs.read', args: { path: 'notes.txt' } }],
    },
    { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1', toolName: 'fs.read' },
  ]);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user');
  // assistant 渲染为带 tool_calls 的消息
  assert.equal(out[2].role, 'assistant');
  const tcs = out[2].tool_calls as Array<Record<string, unknown>>;
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0].id, 'call_1');
  assert.equal((tcs[0].function as Record<string, unknown>).name, 'fs.read');
  assert.equal((tcs[0].function as Record<string, unknown>).arguments, JSON.stringify({ path: 'notes.txt' }));
  // tool 结果消息带 tool_call_id
  assert.equal(out[3].role, 'tool');
  assert.equal(out[3].tool_call_id, 'call_1');
  assert.equal(out[3].name, 'fs.read');
  // 无 toolCalls 的 assistant 不应带 tool_calls 字段
  const plain = toOpenAIMessages([{ role: 'assistant', content: 'let me call' }]);
  assert.equal(plain[0].role, 'assistant');
  assert.equal('tool_calls' in plain[0], false);
});

// ---- B8：Claude 后续请求消息映射（assistant tool_use + user tool_result）（审查项 1） ----
test('B8 toAnthropicMessages：assistant 渲染 tool_use，tool 包裹为 tool_result', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tu_1', toolId: 'fs.read', args: { path: 'notes.txt' } }],
    },
    { role: 'tool', content: '{"ok":true}', toolCallId: 'tu_1', toolName: 'fs.read' },
  ]);
  assert.equal(system, 'sys');
  assert.equal(messages[0].role, 'user');
  // assistant 含 tool_use 块
  const a = messages[1] as Record<string, unknown>;
  assert.equal(a.role, 'assistant');
  const blocks = a.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0].type, 'tool_use');
  assert.equal(blocks[0].id, 'tu_1');
  assert.equal(blocks[0].name, 'fs.read');
  assert.deepEqual(blocks[0].input, { path: 'notes.txt' });
  // tool 结果包裹
  const u = messages[2] as Record<string, unknown>;
  assert.equal(u.role, 'user');
  const tcontent = u.content as Array<Record<string, unknown>>;
  assert.equal(tcontent[0].type, 'tool_result');
  assert.equal(tcontent[0].tool_use_id, 'tu_1');
});

// ---- B10：网关第二轮请求保留 assistant 工具调用历史（不丢发起调用的消息）（审查项 1） ----
class ProbeAdapter implements ModelAdapter {
  provider = 'probe';
  model = 'p';
  async *chat(req: ModelRequest): AsyncIterable<ModelEvent> {
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === 'tool') {
      const idxTool = req.messages.findIndex((m) => m.role === 'tool');
      const assistantWithCalls = req.messages
        .slice(0, idxTool)
        .find((m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0);
      assert.ok(assistantWithCalls, '第二轮请求应保留模型发起调用的 assistant 消息（含 toolCalls）');
      // 确认 assistant 在前、tool 在后，且 tool 与 assistant 调用对应
      const tc = (assistantWithCalls as { toolCalls: Array<{ id: string }> }).toolCalls[0];
      assert.equal((last as { toolCallId: string }).toolCallId, tc.id, 'tool 结果应回灌到对应 assistant 调用');
      yield { type: 'text', delta: 'PROBE_OK' };
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    yield { type: 'tool_call', id: 'c1', toolId: 'fs.read', args: { path: 'notes.txt' } };
  }
}

test('B10 第二轮请求保留 assistant 工具调用（历史完整） (通过)', async () => {
  const gw = new ModelGateway({
    adapters: new Map([['probe', new ProbeAdapter()]]),
    tools: new Map([['fs.read', new ReadFileTool()]]),
  });
  const res = await gw.runConversation('读取 notes.txt', 'probe', () => {}, { cwd: fixtureDir });
  assert.equal(res.answer, 'PROBE_OK');
  assert.equal(res.toolCalls, 1);
});

// ---- B11：OpenAI 参数跨 SSE 分片累积，流结束整体解析（审查项 2 / 测试项 6） ----
async function* linesFrom(arr: string[]): AsyncIterable<string> {
  for (const l of arr) yield l;
}
test('B11 OpenAI 参数跨分片累积为合法 JSON (通过)', async () => {
  const stream = linesFrom([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs.read","arguments":"{\\"path\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"notes.txt\\"}"}}]}}]}\n',
    'data: [DONE]\n',
  ]);
  const events: ModelEvent[] = [];
  for await (const e of parseOpenAIChatStream(stream)) events.push(e);
  const tc = events.find((e) => e.type === 'tool_call') as Extract<ModelEvent, { type: 'tool_call' }> | undefined;
  assert.ok(tc, '应产出 tool_call');
  assert.equal(tc!.id, 'call_1');
  assert.equal(tc!.toolId, 'fs.read');
  assert.deepEqual(tc!.args, { path: 'notes.txt' }, '跨分片参数应完整拼接');
});

// ---- B12：OpenAI 无效参数整体解析失败 → 显式报错（测试项 6） ----
test('B12 OpenAI 无效参数：解析失败显式抛错 (通过)', async () => {
  const stream = linesFrom([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"fs.read","arguments":"{bad json"}}]}}]}\n',
    'data: [DONE]\n',
  ]);
  await assert.rejects(() => (async () => {
    for await (const _ of parseOpenAIChatStream(stream)) {
      /* drain */
    }
  })(), /不是合法 JSON/);
});

// ---- B13：Claude 参数跨 SSE 分片累积（审查项 2 / 测试项 6） ----
test('B13 Claude 参数跨分片累积为合法 JSON (通过)', async () => {
  const stream = linesFrom([
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"fs.read"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"notes.txt\\"}"}}',
    'event: content_block_stop',
    'data: {"type":"content_block_stop"}',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ]);
  const events: ModelEvent[] = [];
  for await (const e of parseClaudeChatStream(stream)) events.push(e);
  const tc = events.find((e) => e.type === 'tool_call') as Extract<ModelEvent, { type: 'tool_call' }> | undefined;
  assert.ok(tc, '应产出 tool_call');
  assert.equal(tc!.id, 'tu_1');
  assert.equal(tc!.toolId, 'fs.read');
  assert.deepEqual(tc!.args, { path: 'notes.txt' }, '跨分片参数应完整拼接');
});

// ---- B14：Claude 无效参数整体解析失败 → 显式报错（测试项 6） ----
test('B14 Claude 无效参数：解析失败显式抛错 (通过)', async () => {
  const stream = linesFrom([
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"fs.read"}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{bad"}}',
    'event: content_block_stop',
    'data: {"type":"content_block_stop"}',
    'event: message_stop',
    'data: {"type":"message_stop"}',
  ]);
  await assert.rejects(() => (async () => {
    for await (const _ of parseClaudeChatStream(stream)) {
      /* drain */
    }
  })(), /不是合法 JSON/);
});

// ---- B9：读取工具越界防护（realpath 规范化）（审查项 6） ----
test('B9 读取工具：越界路径被拒绝，正常嵌套文件可读 (通过)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b9-'));
  fs.writeFileSync(path.join(root, 'ok.txt'), 'INSIDE');
  const outside = path.join(root, '..', 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE');
  const tool = new ReadFileTool();
  const ok = await tool.execute({ path: 'ok.txt' }, { cwd: root });
  assert.equal(ok.ok, true);
  assert.ok(String(ok.data).includes('INSIDE'));
  const escape = await tool.execute({ path: '../outside.txt' }, { cwd: root });
  assert.equal(escape.ok, false, '.. 越界应被拒绝');
  const abs = await tool.execute({ path: outside }, { cwd: root });
  assert.equal(abs.ok, false, '绝对越界路径应被拒绝');
  fs.rmSync(outside, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
