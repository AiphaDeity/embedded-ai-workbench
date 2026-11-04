import * as path from 'node:path';

// STM32 构建命令构造（架构基线：工具调度 / 执行节点）。
// 仅生成官方无头（headless）构建命令；真实构建需在已安装工具链的环境中执行。
// 本轮环境未安装 Keil / STM32CubeIDE，真实构建标记为「阻塞」。

export type Toolchain = 'keil' | 'stm32cubeide';

export interface BuildRequest {
  toolchain: Toolchain;
  projectPath: string; // Keil: *.uvprojx；CubeIDE: 工程目录（含 .project/.cproject）
  workspace?: string; // CubeIDE 工作区（默认取工程父目录）
  target?: string; // 构建配置，如 Debug / Release
}

export interface BuildCommand {
  command: string;
  args: string[];
  note: string;
}

// Keil UV4 无头构建：-b 构建，-j0 并行，-o 输出日志
export function keilBuildCommand(req: BuildRequest, exePath?: string): BuildCommand {
  const exe = exePath ?? process.env['EXECUTOR__KEIL_PATH'] ?? 'UV4.exe';
  return {
    command: exe,
    args: ['-b', req.projectPath, '-j0', '-o', 'build_log.txt'],
    note: 'Keil UV4 headless build; 退出码 0 表示成功',
  };
}

// STM32CubeIDE 无头构建：Eclipse CDT headlessbuild 应用
export function cubeideBuildCommand(req: BuildRequest, exePath?: string): BuildCommand {
  const exe = exePath ?? process.env['EXECUTOR__STM32CUBEIDE_PATH'] ?? 'stm32cubeide.exe';
  const ws = req.workspace ?? path.dirname(req.projectPath);
  const target = req.target ?? 'Debug';
  return {
    command: exe,
    args: ['-nosplash', '-application', 'org.eclipse.cdt.managedbuilder.core.headlessbuild', '-data', ws, '-build', target],
    note: 'STM32CubeIDE headless build; 退出码 0 表示成功',
  };
}

export function buildCommand(req: BuildRequest, exePath?: string): BuildCommand {
  return req.toolchain === 'keil' ? keilBuildCommand(req, exePath) : cubeideBuildCommand(req, exePath);
}
