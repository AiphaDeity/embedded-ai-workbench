import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkstationStore, newId } from './persistence.js';
import type { Asset, Run, RunStatus } from './types.js';

// 任务引擎：聚焦「最小任务恢复」与生命周期约束（任务F）。
// 不实现完整分布式调度。

export class RefuseOverwriteError extends Error {}

export interface RecoverReport {
  unknown: string[]; // 无法判定成功/失败（保留，不盲目判定）
  waiting: string[]; // 等待自身执行节点重连
  terminated: string[]; // 本次启动显式终止
  pendingCancel: string[]; // 已请求取消但无执行端停止证据，恢复未自动终止（待执行端 confirmCancel）
}

export class TaskEngine {
  constructor(private store: WorkstationStore) {}

  // 取消请求：仅标记「已发起取消」，状态置为 cancel_requested。
  // 这是请求，不等同于取消成功——需执行端/操作员确认（见 confirmCancel）。
  requestCancel(runId: string): void {
    this.store.updateRunCancellation(runId, true, 'cancel_requested');
  }

  // 确认取消：仅在执行端停止、或操作员显式确认后调用，才进入终态 cancelled。
  confirmCancel(runId: string): void {
    this.store.updateRunStatus(runId, 'cancelled');
  }

  // 服务启动时对账：把「运行/等待/未知/取消请求」的 Run 重新归类，
  // 以区分「成功 / 失败 / 结果未知」，避免静默丢失或重复副作用（任务F）。
  // 审查项 6（恢复）：仅按「原执行节点」对账，不依据其他节点的在线情况改变状态；
  //          取消请求与已确认取消分离——离线任务绝不在此静默标为已取消；
  //          结果不明时保留 unknown。
  recoverOnStartup(liveExecutors: Set<string>, opts?: { terminateWaiting?: boolean }): RecoverReport {
    const report: RecoverReport = { unknown: [], waiting: [], terminated: [], pendingCancel: [] };
    const candidates = this.store.listRunsByStatus(['running', 'waiting_executor', 'unknown', 'cancel_requested']);
    for (const run of candidates) {
      // 仅看「自身执行节点」是否在线；其他节点是否在线与本条任务无关（审查项 6）
      const ownExecutorLive = run.executorId != null && liveExecutors.has(run.executorId);

      if (ownExecutorLive) {
        // 自身节点在线：等待其重连后上报真实结果，不在这里判定终态。
        // 若是取消请求态，保留该状态（执行端回来后确认取消），仍计入等待。
        if (run.status !== 'cancel_requested') {
          this.store.updateRunStatus(run.id, 'waiting_executor');
        }
        report.waiting.push(run.id);
        continue;
      }

      // 自身执行节点离线（或无关联节点）
      if (run.cancelRequested) {
        // 第三轮复验（审查项 4）：恢复策略【不得】代替执行端停止确认。
        // 启动期恢复没有「执行端已停止」的证据；即使 operator 设了 terminateWaiting，
        // 也绝不能在此静默标为 cancelled。保留取消请求态（cancel_requested），
        // 等待执行端重连后通过 confirmCancel 真实确认；无法确认时归入 pendingCancel。
        // 终态 cancelled 只能由执行端调用 confirmCancel() 进入（见下）。
        report.pendingCancel.push(run.id);
        continue;
      }

      // 普通离线任务：结果不明，保留 unknown，不盲目判定/终止。
      // 注意：terminateWaiting 仅作用于「已请求取消」的任务，普通离线任务绝不静默取消。
      this.store.updateRunStatus(run.id, 'unknown');
      report.unknown.push(run.id);
    }
    return report;
  }

  // 文件写入：工程边界校验 + 四类冲突显式区分（任务F / 审查项 2/3/4）。
  //  - 边界：拒绝逃出工程根（含 `..` 与指向根外的目录联接/符号链接）。
  //  - 冲突：区分 新建 / 修改 / 外部删除 / 未登记已有文件；
  //          除「正常修改（磁盘与记录一致）」外，其余冲突不得静默覆盖，需显式 force。
  //  - 乐观并发（审查项 3 / 第三轮复验）：修改生成时基于某个已登记版本（expectedHash），
  //    若当前已登记版本已被更新（哈希不符），说明这是「旧修改」，拒绝覆盖新版本，除非显式 force。
  writeAssetGuarded(
    projectId: string,
    filePath: string,
    content: string,
    opts?: { force?: boolean; mime?: string; expectedHash?: string }
  ): Asset {
    const proj = this.store.getProject(projectId);
    if (!proj) throw new Error(`project not found: ${projectId}`);
    const rootAbs = path.resolve(proj.rootPath);
    const abs = path.resolve(rootAbs, filePath);

    // 边界校验 1：解析后的绝对路径必须在工程根内（捕获 `..` 等字面越界）
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new RefuseOverwriteError(`path escapes project root: ${filePath}`);
    }
    // 边界校验 2：从目标路径向上走到「最近已存在的祖先」并 realpath 规范化，
    // 捕获上层目录中的联接/符号链接越界（审查项 1：父目录不存在时不能跳过大检查）。
    // 校验 3：若目标文件自身已存在，也 realpath 校验，捕获指向根外的文件链接。
    // 任何路径检查失败都【不得直接放行】（fail-closed）：未知错误也拒绝而非跳过。
    const rootCanon = fs.realpathSync(rootAbs);
    let walk = abs;
    let checkedAncestor = false;
    while (!checkedAncestor) {
      if (fs.existsSync(walk)) {
        let canon: string;
        try {
          canon = fs.realpathSync(walk);
        } catch (e) {
          // 真实存在的路径却 realpath 失败（权限等）→ fail-closed，拒绝而非放行
          if (e instanceof RefuseOverwriteError) throw e;
          throw new RefuseOverwriteError(
            `cannot resolve safe path for ${filePath} (realpath failed): ${(e as Error).message}`
          );
        }
        if (canon !== rootCanon && !canon.startsWith(rootCanon + path.sep)) {
          throw new RefuseOverwriteError(`path escapes project root via link at ${walk}: ${filePath}`);
        }
        checkedAncestor = true;
      } else {
        const parent = path.dirname(walk);
        if (parent === walk) {
          // 已走到文件系统根仍无已存在祖先——理论上不会到达（rootAbs 必存在），fail-closed
          throw new RefuseOverwriteError(`cannot resolve a safe existing ancestor for ${filePath}`);
        }
        walk = parent;
      }
    }

    const existing = this.store.findAssetByPath(projectId, filePath);
    const onDiskExists = fs.existsSync(abs);
    let onDisk: string | null = null;
    if (onDiskExists) {
      try {
        onDisk = fs.readFileSync(abs, 'utf8');
      } catch {
        onDisk = null;
      }
    }

    // 情形一：未登记文件（磁盘已有同名文件，但工作站无记录）→ 先确认再覆盖
    if (!existing && onDiskExists) {
      if (!opts?.force) {
        throw new RefuseOverwriteError(
          `file exists on disk but not tracked by workstation: ${filePath}; pass force to adopt/overwrite`
        );
      }
    }

    // 情形二/三：已登记文件
    if (existing) {
      if (onDisk === null) {
        // 外部删除冲突：已登记文件被外部删除，不静默重建
        if (!opts?.force) {
          throw new RefuseOverwriteError(
            `tracked file ${filePath} was deleted externally; pass force to recreate`
          );
        }
      } else {
        // 外部修改冲突：磁盘内容哈希与记录不一致，拒绝覆盖
        const diskHash = crypto.createHash('sha256').update(onDisk).digest('hex');
        if (diskHash !== existing.contentHash) {
          if (!opts?.force) {
            throw new RefuseOverwriteError(
              `asset ${filePath} changed on disk (${existing.contentHash} -> ${diskHash}); refuse to overwrite without explicit force`
            );
          }
        }
        // 乐观并发冲突（审查项 3 / 第三轮复验）：本次修改基于旧版本 expectedHash，
        // 但当前已登记版本已被更新（哈希不符）→ 旧修改会覆盖新版本，拒绝，除非显式 force。
        if (opts?.expectedHash !== undefined && opts.expectedHash !== existing.contentHash) {
          if (!opts?.force) {
            throw new RefuseOverwriteError(
              `stale modification: based on hash ${opts.expectedHash} but current registered is ${existing.contentHash}; refuse to overwrite newer version without explicit force`
            );
          }
        }
      }
    }

    // 真实写入文件（保留原始格式，约束 6）
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return this.store.upsertAsset({
      id: existing?.id ?? newId('asset'),
      projectId,
      path: filePath,
      mime: opts?.mime ?? existing?.mime ?? 'text/plain',
      contentHash: hash,
      size: content.length,
    });
  }

  // 有副作用的操作不盲目自动重试（任务F）。
  shouldRetry(run: Run, attempt: number): boolean {
    if (!run.retryPolicy.autoRetry) return false;
    if (run.hasSideEffects) return false; // 副作用操作禁止自动重试
    return attempt < run.retryPolicy.maxAttempts;
  }
}

