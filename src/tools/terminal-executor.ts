import { spawn, type ChildProcess } from 'node:child_process';

// 本地终端执行节点（约束3：与网页/桌面窗口独立）。
// 支持：指定工作目录启动、实时输出、交互输入、停止与进程回收。
//
// 独立执行服务方案（审查项 5）：
//  - 当前 LocalTerminal 在应用进程内 spawn 子进程，已验证启动/输出/取消/回收。
//  - 远程或多用户场景应把执行节点拆为独立常驻服务（独立进程/容器），通过
//    socket/HTTP 暴露 spawn/onData/write/kill/wait，UI 与执行服务解耦；
//    每个 Run 关联一个 Executor（run.executorId），服务重启后据此对账。
//  - 交互式场景建议用 PTY（如 node-pty）替代管道以获得终端语义；
//    本实现用管道已覆盖非交互构建/命令场景，PTY 为后续增强。

// 审查项 5：子进程默认**不继承**服务进程的全部环境变量，仅透传白名单 +
// 调用方显式传入的变量。避免出现「测试标记 / 真实凭据」等被意外泄漏到子进程。
// Windows 下 PATH/SystemRoot 等是子进程（如 node、cmd）运行所必需的，列入白名单。
const DEFAULT_ENV_WHITELIST = [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
];

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalHandle {
  pid: number;
  onData(cb: (chunk: string) => void): void;
  onError(cb: (err: Error) => void): void;
  write(input: string): void;
  end(): void; // 关闭 stdin，常用于交互式输入后通知 EOF
  kill(signal?: NodeJS.Signals | number): void;
  wait(): Promise<TerminalExit>;
  isAlive(): boolean;
}

// 整棵进程树回收（审查项 7）：
//  - POSIX：子进程以 detached 方式加入独立进程组，kill(-pgid) 连带终止所有后代；
//  - Windows：taskkill /T 按进程树递归终止后代。
// 仅杀「本执行节点启动的进程及其后代」，不影响其他无关进程。
function killTree(pid: number, signal: NodeJS.Signals | number = 'SIGTERM'): void {
  if (!pid || pid < 0) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, signal); // 进程组（含后代）
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* 进程已退出 */
      }
    }
  }
}

export class LocalTerminal {
  private buildEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of DEFAULT_ENV_WHITELIST) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    if (extra) Object.assign(env, extra); // 调用方显式注入（如虚拟凭据隔离测试）
    return env;
  }

  spawn(opts: SpawnOptions): TerminalHandle {
    const child: ChildProcess = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: this.buildEnv(opts.env),
      windowsHide: true,
      // 加入独立进程组/会话，使其成为「进程树根」，便于整棵树回收（审查项 7）：
      //  - POSIX：kill(-pgid) 连带终止所有后代；
      //  - Windows：保持非 detached，taskkill /T 可递归终止后代（本沙箱下 detached 孙进程无法启动）。
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const dataCbs: Array<(c: string) => void> = [];
    const errCbs: Array<(e: Error) => void> = [];
    let exited = false;
    let resolveExit: ((r: TerminalExit) => void) | null = null;
    const exitPromise = new Promise<TerminalExit>((resolve) => {
      resolveExit = resolve;
    });
    // 仅在 stdio 全部关闭（输出已排空）后结算，区分「进程退出」与「输出排空」（审查项 7）。
    // 不依赖 'exit' 提前结算：exit 仅记录信息，避免 wait() 过早返回导致输出丢失。
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const settle = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      resolveExit?.({ exitCode: code ?? exitCode, signal: signal ?? exitSignal });
    };
    const emit = (s: string) => dataCbs.forEach((cb) => cb(s));
    child.stdout?.on('data', (d) => emit(d.toString()));
    child.stderr?.on('data', (d) => emit(d.toString()));
    child.on('error', (e) => errCbs.forEach((cb) => cb(e)));
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal ?? null;
    });
    child.on('close', (code, signal) => settle(code, signal));

    return {
      pid: child.pid ?? -1,
      onData: (cb) => dataCbs.push(cb),
      onError: (cb) => errCbs.push(cb),
      write: (input) => {
        child.stdin?.write(input);
      },
      end: () => {
        child.stdin?.end();
      },
      kill: (signal) => {
        // 终止整棵进程树，而非仅直接子进程（审查项 7）
        killTree(child.pid ?? -1, signal ?? 'SIGTERM');
      },
      wait: () => exitPromise,
      isAlive: () => !exited,
    };
  }
}
