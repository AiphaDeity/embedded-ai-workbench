import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  Project,
  Asset,
  Session,
  Run,
  RunStatus,
  Step,
  ToolCall,
  ToolResult,
  Artifact,
  Connection,
  Executor,
  RetryPolicy,
} from './types.js';

export interface Store {
  db: DatabaseSync;
  close(): void;
}

const SCHEMA_VERSION = 1;

const MIGRATION = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, root_path TEXT,
  schema_version INTEGER, created_at TEXT, updated_at TEXT, meta TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, project_id TEXT, path TEXT, mime TEXT,
  content_hash TEXT, size INTEGER, schema_version INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, model_adapter TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, status TEXT,
  input TEXT, output TEXT, has_side_effects INTEGER,
  retry_max INTEGER, retry_auto INTEGER, executor_id TEXT, cancel_requested INTEGER, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, run_id TEXT, idx INTEGER, kind TEXT, status TEXT,
  summary TEXT, detail TEXT, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, step_id TEXT, tool_id TEXT, args TEXT,
  approved INTEGER, executed INTEGER, result TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, run_id TEXT, project_id TEXT, type TEXT,
  ref TEXT, schema_version INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, kind TEXT, name TEXT, config_ref TEXT,
  status TEXT, expires_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS executors (
  id TEXT PRIMARY KEY, kind TEXT, endpoint TEXT, online INTEGER, last_heartbeat TEXT
);
`;

export function openStore(dbPath: string): Store {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATION);
  return {
    db,
    close: () => db.close(),
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ---------- Row mappers ----------
function rowToRun(r: Record<string, unknown>): Run {
  const retry: RetryPolicy = {
    maxAttempts: Number(r['retry_max'] ?? 1),
    autoRetry: Number(r['retry_auto'] ?? 0) === 1,
  };
  return {
    id: String(r['id']),
    sessionId: String(r['session_id']),
    projectId: String(r['project_id']),
    status: String(r['status']) as RunStatus,
    input: String(r['input']),
    output: r['output'] == null ? undefined : String(r['output']),
    hasSideEffects: Number(r['has_side_effects'] ?? 0) === 1,
    retryPolicy: retry,
    executorId: r['executor_id'] == null ? undefined : String(r['executor_id']),
    cancelRequested: Number(r['cancel_requested'] ?? 0) === 1 ? true : undefined,
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
  };
}

// ---------- WorkstationStore ----------
export class WorkstationStore {
  constructor(private store: Store) {}

  get db(): DatabaseSync {
    return this.store.db;
  }

  close(): void {
    this.store.close();
  }

  // ---- Project ----
  createProject(p: Omit<Project, 'schemaVersion' | 'createdAt' | 'updatedAt' | 'meta'> & { meta?: Record<string, unknown> }): Project {
    const t = now();
    const proj: Project = { ...p, meta: p.meta ?? {}, schemaVersion: SCHEMA_VERSION, createdAt: t, updatedAt: t };
    this.db
      .prepare(
        'INSERT OR REPLACE INTO projects (id,name,kind,root_path,schema_version,created_at,updated_at,meta) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(proj.id, proj.name, proj.kind, proj.rootPath, proj.schemaVersion, proj.createdAt, proj.updatedAt, JSON.stringify(proj.meta));
    return proj;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r['id']),
      name: String(r['name']),
      kind: String(r['kind']) as Project['kind'],
      rootPath: String(r['root_path']),
      schemaVersion: Number(r['schema_version']),
      createdAt: String(r['created_at']),
      updatedAt: String(r['updated_at']),
      meta: JSON.parse(String(r['meta'] ?? '{}')),
    };
  }

  // ---- Asset（保留原始格式 + 版本哈希） ----
  upsertAsset(a: Omit<Asset, 'schemaVersion' | 'createdAt'> & { createdAt?: string }): Asset {
    const t = a.createdAt ?? now();
    const asset: Asset = { ...a, schemaVersion: SCHEMA_VERSION, createdAt: t };
    this.db
      .prepare(
        'INSERT OR REPLACE INTO assets (id,project_id,path,mime,content_hash,size,schema_version,created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(asset.id, asset.projectId, asset.path, asset.mime, asset.contentHash, asset.size, asset.schemaVersion, asset.createdAt);
    return asset;
  }

  findAssetByPath(projectId: string, filePath: string): Asset | undefined {
    const r = this.db.prepare('SELECT * FROM assets WHERE project_id=? AND path=?').get(projectId, filePath) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r['id']),
      projectId: String(r['project_id']),
      path: String(r['path']),
      mime: String(r['mime']),
      contentHash: String(r['content_hash']),
      size: Number(r['size']),
      schemaVersion: Number(r['schema_version']),
      createdAt: String(r['created_at']),
    };
  }

  // ---- Session ----
  createSession(s: Omit<Session, 'createdAt' | 'updatedAt'>): Session {
    const t = now();
    const sess: Session = { ...s, createdAt: t, updatedAt: t };
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id,project_id,title,model_adapter,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(sess.id, sess.projectId, sess.title, sess.modelAdapter, sess.createdAt, sess.updatedAt);
    return sess;
  }

  // ---- Run ----
  createRun(r: Omit<Run, 'createdAt' | 'updatedAt'>): Run {
    const t = now();
    const run: Run = { ...r, createdAt: t, updatedAt: t };
    this.db
      .prepare(
        'INSERT INTO runs (id,session_id,project_id,status,input,output,has_side_effects,retry_max,retry_auto,executor_id,cancel_requested,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        run.id,
        run.sessionId,
        run.projectId,
        run.status,
        run.input,
        run.output ?? null,
        run.hasSideEffects ? 1 : 0,
        run.retryPolicy.maxAttempts,
        run.retryPolicy.autoRetry ? 1 : 0,
        run.executorId ?? null,
        run.cancelRequested ? 1 : 0,
        run.createdAt,
        run.updatedAt
      );
    return run;
  }

  getRun(id: string): Run | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToRun(r) : undefined;
  }

  updateRunStatus(id: string, status: RunStatus, output?: string): void {
    const t = now();
    if (output !== undefined) {
      this.db.prepare('UPDATE runs SET status=?, output=?, updated_at=? WHERE id=?').run(status, output, t, id);
    } else {
      this.db.prepare('UPDATE runs SET status=?, updated_at=? WHERE id=?').run(status, t, id);
    }
  }

  // 设置取消请求标记（审查项 6：取消请求与确认取消分离）
  updateRunCancellation(id: string, cancelRequested: boolean, status?: RunStatus): void {
    const t = now();
    if (status !== undefined) {
      this.db
        .prepare('UPDATE runs SET cancel_requested=?, status=?, updated_at=? WHERE id=?')
        .run(cancelRequested ? 1 : 0, status, t, id);
    } else {
      this.db.prepare('UPDATE runs SET cancel_requested=?, updated_at=? WHERE id=?').run(cancelRequested ? 1 : 0, t, id);
    }
  }

  listRunsByStatus(statuses: RunStatus[]): Run[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM runs WHERE status IN (${placeholders})`).all(...statuses) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  // ---- Step ----
  appendStep(s: Omit<Step, 'startedAt' | 'finishedAt'> & { startedAt?: string; finishedAt?: string }): Step {
    const step: Step = { ...s, startedAt: s.startedAt, finishedAt: s.finishedAt };
    this.db
      .prepare('INSERT INTO steps (id,run_id,idx,kind,status,summary,detail,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(step.id, step.runId, step.index, step.kind, step.status, step.summary, JSON.stringify(step.detail), step.startedAt ?? null, step.finishedAt ?? null);
    return step;
  }

  updateStep(id: string, status: RunStatus, detail?: Record<string, unknown>, finishedAt?: string): void {
    const t = finishedAt ?? now();
    if (detail) {
      this.db.prepare('UPDATE steps SET status=?, detail=?, finished_at=? WHERE id=?').run(status, JSON.stringify(detail), t, id);
    } else {
      this.db.prepare('UPDATE steps SET status=?, finished_at=? WHERE id=?').run(status, t, id);
    }
  }

  // ---- ToolCall ----
  recordToolCall(tc: Omit<ToolCall, 'result'> & { result?: ToolResult }): void {
    this.db
      .prepare('INSERT INTO tool_calls (id,step_id,tool_id,args,approved,executed,result,error) VALUES (?,?,?,?,?,?,?,?)')
      .run(
        tc.id,
        tc.stepId,
        tc.toolId,
        JSON.stringify(tc.args),
        tc.approved ? 1 : 0,
        tc.executed ? 1 : 0,
        tc.result ? JSON.stringify(tc.result) : null,
        tc.error ?? null
      );
  }

  // ---- Artifact ----
  createArtifact(a: Omit<Artifact, 'schemaVersion' | 'createdAt'>): Artifact {
    const art: Artifact = { ...a, schemaVersion: SCHEMA_VERSION, createdAt: now() };
    this.db
      .prepare('INSERT INTO artifacts (id,run_id,project_id,type,ref,schema_version,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(art.id, art.runId, art.projectId, art.type, art.ref, art.schemaVersion, art.createdAt);
    return art;
  }

  // ---- Connection（凭据只存引用） ----
  upsertConnection(c: Omit<Connection, 'createdAt'>): Connection {
    const conn: Connection = { ...c, createdAt: now() };
    this.db
      .prepare('INSERT OR REPLACE INTO connections (id,kind,name,config_ref,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(conn.id, conn.kind, conn.name, conn.configRef, conn.status, conn.expiresAt ?? null, conn.createdAt);
    return conn;
  }

  // ---- Executor ----
  upsertExecutor(e: Executor): Executor {
    this.db
      .prepare('INSERT OR REPLACE INTO executors (id,kind,endpoint,online,last_heartbeat) VALUES (?,?,?,?,?)')
      .run(e.id, e.kind, e.endpoint, e.online ? 1 : 0, e.lastHeartbeat ?? null);
    return e;
  }

  setExecutorOnline(id: string, online: boolean): void {
    this.db.prepare('UPDATE executors SET online=?, last_heartbeat=? WHERE id=?').run(online ? 1 : 0, now(), id);
  }
}

export { SCHEMA_VERSION };
