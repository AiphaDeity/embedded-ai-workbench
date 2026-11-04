import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalTerminal, type TerminalHandle, type TerminalExit, type SpawnOptions } from '../../src/tools/terminal-executor.js';
import { keilBuildCommand, cubeideBuildCommand } from '../../src/build/stm32-build.js';

const term = new LocalTerminal();
const fixtureDir = path.join(import.meta.dirname, 'fixture');

// 审查项（第三轮复验 指令1）：终端测试必须有界超时与失败清理，避免 C2 后挂起阻塞整套；
// 同时记录进程启动 pid 与退出事件，便于定位挂起原因。
const TERM_TIMEOUT_MS = 20000;
async function boundedWait(h: TerminalHandle, label: string): Promise<TerminalExit> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TerminalExit>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`[${label}] 终端等待超时 ${TERM_TIMEOUT_MS}ms，疑似挂起（已触发清理）`)), TERM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([h.wait(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// 统一封装：启动即记录 pid；无论成功失败都 kill 清理并等待回收，避免遗留进程挂住事件循环。
async function withTerm(label: string, spec: SpawnOptions, body: (h: TerminalHandle) => Promise<void>): Promise<void> {
  const h = term.spawn(spec);
  console.log(`[term-start] ${label} pid=${h.pid}`);
  try {
    await body(h);
  } finally {
    try {
      h.kill();
    } catch {
      /* ignore */
    }
    // 确保回收（忽略已退出时的报错）
    await h.wait().catch(() => {});
  }
}

// ---- C1：指定工作目录启动终端，实时接收 stdout/stderr，进程回收 ----
test('C1 指定工作目录启动终端并实时接收输出 (通过)', async () => {
  const chunks: string[] = [];
  await withTerm('C1', {
    command: process.execPath,
    args: ['-e', "process.stdout.write('HELLO_TERM'); process.stderr.write('ERR_TERM'); process.exit(0)"],
    cwd: process.cwd(),
  }, async (h) => {
    h.onData((d) => chunks.push(d));
    const exit = await boundedWait(h, 'C1');
    assert.equal(exit.exitCode, 0);
    assert.ok(chunks.join('').includes('HELLO_TERM'));
    assert.ok(chunks.join('').includes('ERR_TERM'));
    assert.equal(h.isAlive(), false);
  });
});

// ---- C2：交互输入与输出回显 ----
test('C2 交互输入与输出回显 (通过)', async () => {
  const chunks: string[] = [];
  await withTerm('C2', {
    command: process.execPath,
    args: ['-e', "const s=require('fs').readFileSync(0,'utf8'); process.stdout.write('echo:'+s.trim())"],
    cwd: process.cwd(),
  }, async (h) => {
    h.onData((d) => chunks.push(d));
    h.write('ping\n');
    h.end(); // 关闭 stdin，通知 EOF
    const exit = await boundedWait(h, 'C2');
    assert.equal(exit.exitCode, 0);
    assert.ok(chunks.join('').includes('echo:ping'));
  });
});

// ---- C3：停止与进程回收（执行节点断线后的状态可感知） ----
test('C3 停止与进程回收 (通过)', async () => {
  await withTerm('C3', { command: process.execPath, args: ['-e', 'setInterval(()=>{}, 1000)'], cwd: process.cwd() }, async (h) => {
    assert.equal(h.isAlive(), true);
    h.kill(); // 指令执行节点停止
    const exit = await boundedWait(h, 'C3');
    assert.equal(h.isAlive(), false);
    assert.ok(!(exit.exitCode === 0 && exit.signal === null), '被取消的进程不应以成功退出码结束');
  });
});

// ---- C4：STM32 无头构建命令构造（两种工具链） ----
test('C4 STM32 无头构建命令构造（Keil / STM32CubeIDE）(通过)', () => {
  const keil = keilBuildCommand({ toolchain: 'keil', projectPath: 'Demo.uvprojx' });
  assert.equal(keil.args[0], '-b');
  assert.equal(keil.args[1], 'Demo.uvprojx');

  const cube = cubeideBuildCommand({ toolchain: 'stm32cubeide', projectPath: '/proj', target: 'Debug' });
  assert.ok(cube.args.includes('-application'));
  assert.ok(cube.args.includes('org.eclipse.cdt.managedbuilder.core.headlessbuild'));
  assert.ok(cube.args.includes('-build'));
});

// ---- C5：真实 STM32 构建（阻塞：未安装工具链且无样例工程） ----
test('C5 真实 STM32 构建（若工具链存在则尝试；否则阻塞）', async (t) => {
  const keilExe = process.env['EXECUTOR__KEIL_PATH'] ?? 'C:/Keil_v5/UV4/UV4.exe';
  const cubeExe =
    process.env['EXECUTOR__STM32CUBEIDE_PATH'] ?? 'C:/Program Files (x86)/STMicroelectronics/STM32CubeIDE/stm32cubeide.exe';
  const keilOk = fs.existsSync(keilExe);
  const cubeOk = fs.existsSync(cubeExe);
  if (!keilOk && !cubeOk) {
    t.skip(`未检测到 Keil(${keilExe}) 或 STM32CubeIDE(${cubeExe})；真实构建阻塞。命令构造见 C4。`);
    return;
  }
  t.skip('工具链存在，但本轮未提供隔离样例工程；不擅自构建或烧录用户工程');
});

// ---- C6：并发终端隔离（各运行独立进程，输出不串台）（审查项 5） ----
test('C6 并发终端隔离：各自输出不串台 (通过)', async () => {
  const a: string[] = [];
  const b: string[] = [];
  const hA = term.spawn({ command: process.execPath, args: ['-e', "process.stdout.write('MARKER_A')"], cwd: process.cwd() });
  const hB = term.spawn({ command: process.execPath, args: ['-e', "process.stdout.write('MARKER_B')"], cwd: process.cwd() });
  hA.onData((d) => a.push(d));
  hB.onData((d) => b.push(d));
  console.log(`[term-start] C6A pid=${hA.pid} C6B pid=${hB.pid}`);
  try {
    await Promise.all([boundedWait(hA, 'C6A'), boundedWait(hB, 'C6B')]);
    assert.ok(a.join('').includes('MARKER_A') && !a.join('').includes('MARKER_B'), 'A 不应收到 B 的输出');
    assert.ok(b.join('').includes('MARKER_B') && !b.join('').includes('MARKER_A'), 'B 不应收到 A 的输出');
  } finally {
    hA.kill();
    hB.kill();
    await Promise.all([hA.wait().catch(() => {}), hB.wait().catch(() => {})]);
  }
});

// ---- C7：完整交互链（多行输入→逐行回显）（审查项 5） ----
test('C7 完整交互链：多行输入逐行回显 (通过)', async () => {
  const chunks: string[] = [];
  await withTerm('C7', {
    command: process.execPath,
    args: [
      '-e',
      "const rl=require('readline').createInterface({input:process.stdin});let n=0;rl.on('line',l=>{n++;process.stdout.write('L'+n+':'+l+' ');if(n>=2)process.exit(0);});",
    ],
    cwd: process.cwd(),
  }, async (h) => {
    h.onData((d) => chunks.push(d));
    h.write('alpha\n');
    h.write('beta\n');
    h.end();
    await boundedWait(h, 'C7');
    const out = chunks.join('');
    assert.ok(out.includes('L1:alpha') && out.includes('L2:beta'), `应回显两行，实际: ${out}`);
  });
});

// ---- C8：kill 后进程回收且 PID 不再存活（审查项 5） ----
test('C8 kill 后回收：isAlive=false 且 PID 不再存活 (通过)', async () => {
  await withTerm('C8', { command: process.execPath, args: ['-e', 'setInterval(()=>{}, 1000)'], cwd: process.cwd() }, async (h) => {
    const pid = h.pid;
    h.kill();
    const exit = await boundedWait(h, 'C8');
    assert.equal(h.isAlive(), false, 'kill 后不应存活');
    assert.ok(!(exit.exitCode === 0 && exit.signal === null), '被终止进程不应以成功退出码结束');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'kill 后进程应已退出');
  });
});

// ---- C9：子进程环境隔离——不默认继承服务全部环境（审查项 5） ----
test('C9 环境隔离：子进程仅见白名单与显式变量，不可见服务标记 (通过)', async () => {
  // 在服务进程注入一个虚拟「凭据/标记」，子进程不应继承
  const SECRET = 'WS_ISOLATION_SECRET_' + Math.random().toString(36).slice(2);
  process.env[SECRET] = 'leaked';
  try {
    const probe = (expr: string) =>
      term.spawn({
        command: process.execPath,
        args: ['-e', `process.stdout.write(String(${expr}))`],
        cwd: process.cwd(),
        env: { WS_EXPLICIT: 'present' }, // 显式注入，应可见
      });

    // 1) 服务私有标记不可见
    const h1 = probe(`process.env[${JSON.stringify(SECRET)}] || 'NONE'`);
    const out1: string[] = [];
    h1.onData((d) => out1.push(d));
    console.log(`[term-start] C9-secret pid=${h1.pid}`);
    const e1 = await boundedWait(h1, 'C9-secret');
    assert.equal(e1.exitCode, 0);
    assert.equal(out1.join('').trim(), 'NONE', '子进程不应继承服务私有环境变量');

    // 2) 白名单变量（PATH）应可见
    const h2 = probe(`process.env.PATH ? 'HAS_PATH' : 'NO_PATH'`);
    const out2: string[] = [];
    h2.onData((d) => out2.push(d));
    await boundedWait(h2, 'C9-path');
    assert.equal(out2.join('').trim(), 'HAS_PATH', '白名单变量 PATH 应透传到子进程');

    // 3) 显式注入变量可见
    const h3 = probe(`process.env.WS_EXPLICIT || 'MISSING'`);
    const out3: string[] = [];
    h3.onData((d) => out3.push(d));
    await boundedWait(h3, 'C9-explicit');
    assert.equal(out3.join('').trim(), 'present', '显式注入变量应可见');

    // 统一失败清理：无论断言成败都 kill 并等待回收
    h1.kill();
    h2.kill();
    h3.kill();
    await Promise.all([h1.wait().catch(() => {}), h2.wait().catch(() => {}), h3.wait().catch(() => {})]);
  } finally {
    delete process.env[SECRET];
  }
});

// ---- C10：后代进程清理——kill 整棵进程树（审查项 7） ----
test('C10 后代进程清理：kill 父进程后后代停止写入 (通过)', async () => {
  const log = path.join(os.tmpdir(), `ws-desc-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.rmSync(log, { force: true });
  // 父进程 spawn 一个后代（共享进程树），自己空转。
  // 孙进程用内联 `node -e`（避免加载 .cjs 文件），每 50ms 向日志追加一行，便于检测其生死。
  // 不显式注入 env：子进程仅继承白名单（PATH/SystemRoot/...），足以启动 node 孙进程；
  // 隔离本身由 C9 单独验证。这同时保证 C10 也走白名单路径，不绕过隔离。
  const grandChildCode = `const fs=require('fs');const log=${JSON.stringify(log)};let n=0;setInterval(()=>{n++;try{fs.appendFileSync(log,String(n)+'\\n')}catch{}},50);`;
  const parentCode = `const cp=require('child_process');cp.spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(grandChildCode)}],{stdio:'ignore'});setInterval(()=>{},1e9);`;

  await withTerm('C10', {
    command: process.execPath,
    args: ['-e', parentCode],
    cwd: process.cwd(),
  }, async (h) => {
    const count = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
    // 等孙进程越过冷启动斜坡、稳定写入（沙箱冷启动可能较慢，给足容差）
    let before = 0;
    for (let i = 0; i < 100 && before < 4; i++) {
      await new Promise((r) => setTimeout(r, 100));
      before = count();
    }
    assert.ok(before >= 4, `后代进程应已开始稳定写入（before=${before}）`);

    h.kill(); // 终止整棵树（父 + 后代，Windows 走 taskkill /T，POSIX 走进程组）
    await boundedWait(h, 'C10');

    // 关键断言：击杀延迟（数百毫秒写盘滞后）排空后，日志应「停止增长」。
    // 不能在 kill 前后比总行数相等——延迟期间孙进程仍会写几行，会误判。
    await new Promise((r) => setTimeout(r, 600));
    const c1 = count();
    await new Promise((r) => setTimeout(r, 800)); // 若后代仍存活，会继续增长
    const c2 = count();
    assert.equal(c2, c1, `后代进程应已被整树回收、停止写入（kill 后日志仍在增长：${c1} -> ${c2}）`);
  });

  fs.rmSync(log, { force: true });
});

// ---- C11：输出排空——wait() 在 stdio 关闭（close）后结算，而非提前于 exit（审查项 7） ----
test('C11 输出排空：wait() 在输出全部就绪后才结算 (通过)', async () => {
  const payload = 'X'.repeat(5000);
  await withTerm('C11', {
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(payload)}); process.exit(0)`],
    cwd: process.cwd(),
  }, async (h) => {
    const out: string[] = [];
    h.onData((d) => out.push(d));
    await boundedWait(h, 'C11'); // 若提前于 exit 结算，输出可能被截断
    assert.equal(out.join(''), payload, 'wait() 返回时 5000 字节输出应完整（未被提前结算截断）');
  });
});
