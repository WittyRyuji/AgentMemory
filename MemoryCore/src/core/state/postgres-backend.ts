import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  IStateBackend,
  PipelineSessionState,
  TaskPayload,
  TimerEntry,
  CaptureAtomicParams,
  CaptureAtomicResult,
} from "./types.js";
import { DEFAULT_PIPELINE_STATE } from "./types.js";
import { PostgresDatabase } from "../store/postgres/client.js";

/** Durable pipeline state, leased queue and owner-checked locks; no disk checkpoint required. */
export class PostgresStateBackend implements IStateBackend {
  private ready?: Promise<void>;
  private destroyed = false;
  constructor(private readonly db: PostgresDatabase) {}
  async initialize() {
    this.ready ??= this.db
      .transaction(
        () =>
          this.db.exec(
            `
    CREATE TABLE IF NOT EXISTS pipeline_sessions (key TEXT PRIMARY KEY,instance_id TEXT NOT NULL,session_id TEXT NOT NULL,state JSONB NOT NULL,buffer JSONB NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS pipeline_sessions_instance ON pipeline_sessions(instance_id);
    CREATE TABLE IF NOT EXISTS pipeline_timers (instance_id TEXT NOT NULL,member TEXT NOT NULL,fire_at DOUBLE PRECISION NOT NULL,PRIMARY KEY(instance_id,member));
    CREATE INDEX IF NOT EXISTS pipeline_timers_due ON pipeline_timers(fire_at);
    CREATE TABLE IF NOT EXISTS pipeline_tasks (id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,payload JSONB NOT NULL,priority INT NOT NULL,created_at DOUBLE PRECISION NOT NULL,owner TEXT,claimed_at DOUBLE PRECISION);
    CREATE INDEX IF NOT EXISTS pipeline_tasks_queue ON pipeline_tasks(priority,created_at) WHERE owner IS NULL;
    CREATE TABLE IF NOT EXISTS pipeline_locks (key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at DOUBLE PRECISION NOT NULL);
  `,
          ),
        true,
      )
      .catch((e) => {
        this.ready = undefined;
        throw e;
      });
    return this.ready;
  }
  private key(i: string, s: string, t?: string, a?: string) {
    return JSON.stringify([i, t ?? "", a ?? "", s]);
  }
  private async ensureSession(i: string, s: string, t?: string, a?: string) {
    await this.initialize();
    await this.db.query(
      "INSERT INTO pipeline_sessions(key,instance_id,session_id,state) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(key) DO NOTHING",
      [
        this.key(i, s, t, a),
        i,
        s,
        JSON.stringify({
          ...DEFAULT_PIPELINE_STATE,
          last_active_time: Date.now(),
        }),
      ],
    );
  }
  async appendBuffer(
    i: string,
    s: string,
    message: string,
    t?: string,
    a?: string,
  ) {
    await this.ensureSession(i, s, t, a);
    await this.db.query(
      "UPDATE pipeline_sessions SET buffer=buffer||$1::jsonb WHERE key=$2",
      [JSON.stringify([message]), this.key(i, s, t, a)],
    );
  }
  async drainBuffer(i: string, s: string, t?: string, a?: string) {
    await this.initialize();
    return this.db.transaction(async () => {
      const row = (
        await this.db.query<{ buffer: string[] }>(
          "SELECT buffer FROM pipeline_sessions WHERE key=$1 FOR UPDATE",
          [this.key(i, s, t, a)],
        )
      ).rows[0];
      await this.db.query(
        "UPDATE pipeline_sessions SET buffer='[]'::jsonb WHERE key=$1",
        [this.key(i, s, t, a)],
      );
      return row?.buffer ?? [];
    });
  }
  async getBufferLength(i: string, s: string, t?: string, a?: string) {
    await this.initialize();
    return Number(
      (
        await this.db.query<{ n: number }>(
          "SELECT jsonb_array_length(buffer) AS n FROM pipeline_sessions WHERE key=$1",
          [this.key(i, s, t, a)],
        )
      ).rows[0]?.n ?? 0,
    );
  }
  async getSessionState(i: string, s: string, t?: string, a?: string) {
    await this.initialize();
    return (
      (
        await this.db.query<{ state: PipelineSessionState }>(
          "SELECT state FROM pipeline_sessions WHERE key=$1",
          [this.key(i, s, t, a)],
        )
      ).rows[0]?.state ?? null
    );
  }
  async updateSessionState(
    i: string,
    s: string,
    patch: Partial<PipelineSessionState>,
    t?: string,
    a?: string,
  ) {
    await this.ensureSession(i, s, t, a);
    await this.db.query(
      "UPDATE pipeline_sessions SET state=state||$1::jsonb WHERE key=$2",
      [JSON.stringify(patch), this.key(i, s, t, a)],
    );
  }
  async deleteSessionState(i: string, s: string, t?: string, a?: string) {
    await this.initialize();
    await this.db.query("DELETE FROM pipeline_sessions WHERE key=$1", [
      this.key(i, s, t, a),
    ]);
  }
  async listActiveSessions(i: string) {
    await this.initialize();
    return (
      await this.db.query<{ session_id: string }>(
        "SELECT DISTINCT session_id FROM pipeline_sessions WHERE instance_id=$1 ORDER BY session_id",
        [i],
      )
    ).rows.map((r) => r.session_id);
  }
  async setTimer(i: string, member: string, fireAtMs: number) {
    await this.initialize();
    await this.db.query(
      "INSERT INTO pipeline_timers VALUES($1,$2,$3) ON CONFLICT(instance_id,member) DO UPDATE SET fire_at=excluded.fire_at",
      [i, member, fireAtMs],
    );
  }
  async setTimerIfEarlier(i: string, member: string, fireAtMs: number) {
    await this.initialize();
    return (
      (
        await this.db.query(
          "INSERT INTO pipeline_timers VALUES($1,$2,$3) ON CONFLICT(instance_id,member) DO UPDATE SET fire_at=excluded.fire_at WHERE pipeline_timers.fire_at>excluded.fire_at",
          [i, member, fireAtMs],
        )
      ).rowCount === 1
    );
  }
  async removeTimer(i: string, member: string) {
    await this.initialize();
    await this.db.query(
      "DELETE FROM pipeline_timers WHERE instance_id=$1 AND member=$2",
      [i, member],
    );
  }
  async getExpiredTimers(i: string, now: number): Promise<TimerEntry[]> {
    await this.initialize();
    return (
      await this.db.query<{
        instance_id: string;
        member: string;
        fire_at: number;
      }>(
        "DELETE FROM pipeline_timers WHERE instance_id=$1 AND fire_at<=$2 RETURNING *",
        [i, now],
      )
    ).rows.map((r) => ({
      instanceId: r.instance_id,
      member: r.member,
      fireAtMs: r.fire_at,
    }));
  }
  /** Scanner uses this instead of a delete-then-enqueue window that could lose timers on a crash. */
  async dispatchExpiredTimers(
    makeTask: (entry: TimerEntry) => TaskPayload,
  ): Promise<number> {
    await this.initialize();
    return this.db.transaction(async () => {
      const rows = (
        await this.db.query<{
          instance_id: string;
          member: string;
          fire_at: number;
        }>(
          "SELECT * FROM pipeline_timers WHERE fire_at<=$1 ORDER BY fire_at LIMIT 100 FOR UPDATE SKIP LOCKED",
          [Date.now()],
        )
      ).rows;
      for (const r of rows) {
        await this.enqueueTask(
          makeTask({
            instanceId: r.instance_id,
            member: `${r.instance_id}\0${r.member}`,
            fireAtMs: r.fire_at,
          }),
        );
        await this.removeTimer(r.instance_id, r.member);
      }
      return rows.length;
    });
  }
  async enqueueTask(task: TaskPayload) {
    await this.initialize();
    const { _msgId, _stream, _ownerId, ...payload } = task;
    await this.db.query(
      "INSERT INTO pipeline_tasks(id,instance_id,payload,priority,created_at) VALUES($1,$2,$3::jsonb,$4,$5)",
      [
        randomUUID(),
        task.instanceId,
        JSON.stringify(payload),
        task.priority,
        task.createdAt,
      ],
    );
  }
  private delivery(r: {
    id: string;
    payload: TaskPayload;
    owner: string;
  }): TaskPayload {
    return {
      ...r.payload,
      _msgId: r.id,
      _ownerId: r.owner,
      _stream: "postgres",
    };
  }
  async consumeTask(
    workerId: string,
    blockMs = 0,
  ): Promise<TaskPayload | null> {
    await this.initialize();
    const deadline = Date.now() + Math.max(0, blockMs);
    do {
      if (this.destroyed) return null;
      const r = (
        await this.db.query<{
          id: string;
          payload: TaskPayload;
          owner: string;
        }>(
          `UPDATE pipeline_tasks SET owner=$1,claimed_at=$2 WHERE id=(SELECT id FROM pipeline_tasks WHERE owner IS NULL ORDER BY priority,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
          [workerId, Date.now()],
        )
      ).rows[0];
      if (r) return this.delivery(r);
      if (Date.now() >= deadline) return null;
      await delay(Math.min(100, deadline - Date.now()));
    } while (true);
  }
  async ackTask(id: string) {
    await this.initialize();
    await this.db.query(
      "DELETE FROM pipeline_tasks WHERE id=$1 AND owner IS NOT NULL",
      [id],
    );
  }
  async ackTaskIfOwned(id: string, owner: string) {
    await this.initialize();
    return (
      (
        await this.db.query(
          "DELETE FROM pipeline_tasks WHERE id=$1 AND owner=$2",
          [id, owner],
        )
      ).rowCount === 1
    );
  }
  async refreshTaskClaim(id: string, owner: string, idle = 0) {
    await this.initialize();
    return (
      (
        await this.db.query(
          "UPDATE pipeline_tasks SET claimed_at=$3 WHERE id=$1 AND owner=$2",
          [id, owner, Date.now() - Math.max(0, idle)],
        )
      ).rowCount === 1
    );
  }
  async replacePendingTask(
    id: string,
    owner: string,
    replacement: TaskPayload,
  ) {
    await this.initialize();
    return this.db.transaction(async () => {
      if (!(await this.ackTaskIfOwned(id, owner))) return false;
      await this.enqueueTask(replacement);
      return true;
    });
  }
  async claimStaleTasks(worker: string, minIdleMs: number, count: number) {
    await this.initialize();
    return (
      await this.db.query<{ id: string; payload: TaskPayload; owner: string }>(
        `UPDATE pipeline_tasks SET owner=$1,claimed_at=$2 WHERE id IN (SELECT id FROM pipeline_tasks WHERE owner IS NOT NULL AND claimed_at<=$3 ORDER BY claimed_at LIMIT $4 FOR UPDATE SKIP LOCKED) RETURNING *`,
        [
          worker,
          Date.now(),
          Date.now() - Math.max(0, minIdleMs),
          Math.max(0, count),
        ],
      )
    ).rows.map((r) => this.delivery(r));
  }
  async getQueueDepth() {
    await this.initialize();
    const r = (
      await this.db.query<{ high: string; low: string }>(
        "SELECT count(*) FILTER(WHERE priority=0) AS high,count(*) FILTER(WHERE priority<>0) AS low FROM pipeline_tasks WHERE owner IS NULL",
      )
    ).rows[0];
    return { high: Number(r.high), low: Number(r.low) };
  }
  async listQueuedTasks() {
    await this.initialize();
    return (
      await this.db.query<{ payload: TaskPayload }>(
        "SELECT payload FROM pipeline_tasks WHERE owner IS NULL ORDER BY priority,created_at,id",
      )
    ).rows.map((r) => r.payload);
  }
  async acquireLock(key: string, owner: string, ttl: number) {
    await this.initialize();
    return (
      (
        await this.db.query(
          "INSERT INTO pipeline_locks VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE pipeline_locks.expires_at<=$4",
          [key, owner, Date.now() + ttl, Date.now()],
        )
      ).rowCount === 1
    );
  }
  async renewLock(key: string, owner: string, ttl: number) {
    await this.initialize();
    return (
      (
        await this.db.query(
          "UPDATE pipeline_locks SET expires_at=$3 WHERE key=$1 AND owner=$2 AND expires_at>$4",
          [key, owner, Date.now() + ttl, Date.now()],
        )
      ).rowCount === 1
    );
  }
  async releaseLock(key: string, owner: string) {
    await this.initialize();
    await this.db.query(
      "DELETE FROM pipeline_locks WHERE key=$1 AND owner=$2",
      [key, owner],
    );
  }
  async captureAtomic(p: CaptureAtomicParams): Promise<CaptureAtomicResult> {
    await this.initialize();
    return this.db.transaction(async () => {
      if (p.messageJson)
        await this.appendBuffer(
          p.instanceId,
          p.sessionId,
          p.messageJson,
          p.teamId,
          p.agentId,
        );
      const state = (await this.getSessionState(
        p.instanceId,
        p.sessionId,
        p.teamId,
        p.agentId,
      )) ?? { ...DEFAULT_PIPELINE_STATE };
      const count = state.conversation_count + p.rounds,
        triggered = count >= p.threshold;
      if (triggered) {
        await this.enqueueTask(p.taskPayload);
        await this.removeTimer(p.instanceId, p.timerMember);
      } else await this.setTimer(p.instanceId, p.timerMember, p.fireAtMs);
      await this.updateSessionState(
        p.instanceId,
        p.sessionId,
        {
          conversation_count: triggered ? 0 : count,
          last_active_time: p.nowMs,
        },
        p.teamId,
        p.agentId,
      );
      return { triggered, conversationCount: triggered ? 0 : count };
    }, true);
  }
  async purgeInstance(i: string) {
    await this.initialize();
    return this.db.transaction(async () => {
      const rows = (
        await this.db.query<{ buffer: unknown[] }>(
          "DELETE FROM pipeline_sessions WHERE instance_id=$1 RETURNING buffer",
          [i],
        )
      ).rows;
      const timers =
        (
          await this.db.query(
            "DELETE FROM pipeline_timers WHERE instance_id=$1",
            [i],
          )
        ).rowCount ?? 0;
      await this.db.query("DELETE FROM pipeline_tasks WHERE instance_id=$1", [
        i,
      ]);
      return {
        sessions: rows.length,
        buffers: rows.filter((r) => r.buffer.length).length,
        timers,
      };
    });
  }
  async destroy() {
    this.destroyed = true;
    await this.db.close();
  }
}
