import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext, ToolExecResult } from './tool.js';

// 只读工具示例：读取工程目录内文本文件。
// readOnly=true → 可被程序执行层自动批准；mcpExposable=true → 可作为 MCP 工具暴露。
export class ReadFileTool implements Tool {
  readonly id = 'fs.read';
  readonly description = '读取工程目录内的文本文件（只读）';
  readonly parameters = {
    type: 'object',
    properties: { path: { type: 'string', description: '相对工程根的路径' } },
    required: ['path'],
  };
  readonly readOnly = true;
  readonly mcpExposable = true;

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecResult> {
    const rel = String(args['path'] ?? '');
    if (!rel) return { ok: false, error: 'missing path' };

    // 审查项 6：先规范化工程根，再解析目标路径并 realpath 规范化
    // （解析符号链接），以防范 `..` 与「符号链接指向工程根之外」的越界。
    let canonicalRoot: string;
    try {
      canonicalRoot = fssync.realpathSync(path.resolve(ctx.cwd));
    } catch {
      return { ok: false, error: 'workspace root unresolvable' };
    }
    const abs = path.resolve(canonicalRoot, rel);
    let canonical: string;
    try {
      canonical = fssync.realpathSync(abs);
    } catch {
      return { ok: false, error: 'path unresolvable (may escape workspace)' };
    }
    if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + path.sep)) {
      return { ok: false, error: 'path escapes workspace root' };
    }
    try {
      const content = await fs.readFile(canonical, 'utf8');
      return { ok: true, data: content, stdout: content };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

