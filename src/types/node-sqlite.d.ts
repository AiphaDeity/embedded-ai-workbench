// node:sqlite 在 Node 22 仍为实验特性，@types/node 可能未覆盖。
// 此处声明最小可用 API，仅用于类型检查；运行期使用 Node 内置实现。
declare module 'node:sqlite' {
  export class StatementSync {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { nativeBinding?: string });
    exec(sql: string): unknown;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export const constants: Record<string, unknown>;
  export function backup(...args: unknown[]): unknown;
}
