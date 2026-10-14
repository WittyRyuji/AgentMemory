/** PostgreSQL + pgvector implementation of the existing memory kernel contracts. */
import type {
  IMemoryStore,
  StoreCapabilities,
  StoreInitResult,
  StoreLogger,
  L0Record,
  L0QueryRow,
  L0CountFilter,
  L0PaginatedFilter,
  L0PaginatedResult,
  L0SessionGroup,
  L0SearchResult,
  L1RecordRow,
  L1QueryFilter,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  L1SearchResult,
  IsolationFilter,
  ProfileRecord,
  ProfileFilter,
  ProfileSyncRecord,
  MemoryContentClearFilter,
  MemoryContentClearResult,
  AuditEntry,
  AuditQueryFilter,
  MemoryRecord,
} from "../types.js";
import type { EmbeddingProviderInfo } from "../embedding.js";
import {
  l0RecordToDoc,
  l1RecordToDoc,
  docToL0QueryRow,
  docToL1RecordRow,
  type L0Doc,
  type L1Doc,
} from "../mongodb/doc-mappers.js";
import { tokenizeForFts, extractQueryTokens } from "../tokenize.js";
import { PostgresDatabase } from "./client.js";
import { Where } from "./documents.js";
import { PostgresEntityStore } from "./entity-store.js";

export interface PostgresMemoryStoreOptions {
  db: PostgresDatabase;
  dimensions: number;
  logger?: StoreLogger;
}
export function vectorLiteral(value: Float32Array, dimensions: number): string {
  if (value.length !== dimensions || !Array.from(value).every(Number.isFinite))
    throw new Error(`Embedding must have ${dimensions} finite values`);
  if (!value.some((v) => v !== 0))
    throw new Error("Zero vectors do not support cosine search");
  return `[${Array.from(value).join(",")}]`;
}
function isolation(filter?: IsolationFilter): Where {
  const w = new Where();
  for (const [key, field] of Object.entries({
    teamId: "team_id",
    userId: "user_id",
    agentId: "agent_id",
    sessionId: "session_id",
    taskId: "task_id",
    sessionKey: "session_key",
  }))
    w.add(field, filter?.[key as keyof IsolationFilter]);
  return w;
}
function pageLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error("Invalid query limit");
  return Math.min(n, 10000);
}

export class PostgresMemoryStore
  extends PostgresEntityStore
  implements IMemoryStore
{
  readonly supportsDeferredEmbedding = true;
  private ready = false;
  private initializing?: Promise<StoreInitResult>;
  private readonly dimensions: number;
  constructor(options: PostgresMemoryStoreOptions) {
    super(options.db);
    if (
      !Number.isInteger(options.dimensions) ||
      options.dimensions < 1 ||
      options.dimensions > 16000
    )
      throw new Error("PostgreSQL embedding dimensions must be 1..16000");
    this.dimensions = options.dimensions;
  }
  async init(provider?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    this.initializing ??= this.db
      .transaction(async () => {
        await this.docs.init();
        await this.db.exec(
          "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
        );
        const expected = {
          dimensions: this.dimensions,
          provider: provider?.provider,
          model: provider?.model,
        };
        const current = await this.docs.get<typeof expected>(
          "config",
          "embedding",
        );
        if (
          current &&
          (current.dimensions !== expected.dimensions ||
            (provider &&
              (current.provider !== provider.provider ||
                current.model !== provider.model)))
        ) {
          throw new Error(
            "PostgreSQL embedding configuration changed; explicit re-embedding migration is required before startup",
          );
        }
        for (const table of ["memory_l0", "memory_l1"]) {
          await this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY, data JSONB NOT NULL, embedding vector(${this.dimensions}),
          search TSVECTOR NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table} ((data->>'team_id'),(data->>'agent_id'),(data->>'session_id'));
        CREATE INDEX IF NOT EXISTS ${table}_data ON ${table} USING GIN(data);
        CREATE INDEX IF NOT EXISTS ${table}_search ON ${table} USING GIN(search);`);
        }
        if (!current) await this.docs.put("config", "embedding", expected);
        this.ready = true;
        return { needsReindex: false };
      }, true)
      .catch((error) => {
        this.initializing = undefined;
        throw error;
      });
    return this.initializing;
  }
  getPostgresDatabase(): PostgresDatabase {
    return this.db;
  }
  isDegraded(): boolean {
    return !this.ready;
  }
  isFtsAvailable(): boolean {
    return this.ready;
  }
  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.ready,
      ftsSearch: this.ready,
      nativeHybridSearch: false,
      nativeBm25Search: false,
      sparseVectors: false,
      profileRows: true,
    };
  }
  close(): void {
    this.ready = false;
    void this.db.close();
  }
  async dispose(): Promise<void> {
    this.ready = false;
    await this.db.close();
  }
  private async ensure(): Promise<void> {
    if (!this.ready) await this.init();
  }
  private async put(
    table: "memory_l0" | "memory_l1",
    doc: L0Doc | L1Doc,
    embedding?: Float32Array,
    insertOnly = false,
  ): Promise<boolean> {
    await this.ensure();
    const values = [
      doc._id,
      JSON.stringify(doc),
      embedding ? vectorLiteral(embedding, this.dimensions) : null,
      doc.tokens,
    ];
    // Replacing content without an embedding invalidates the old vector. Never return a stale match.
    const suffix = insertOnly
      ? ""
      : ` ON CONFLICT(id) DO UPDATE SET data=excluded.data,embedding=excluded.embedding,search=excluded.search
      WHERE ${table}.data->>'team_id'=excluded.data->>'team_id' AND ${table}.data->>'agent_id'=excluded.data->>'agent_id'`;
    const result = await this.db.query(
      `INSERT INTO ${table}(id,data,embedding,search) VALUES($1,$2::jsonb,$3::vector,to_tsvector('simple',$4))${suffix}`,
      values,
    );
    if (result.rowCount !== 1)
      throw new Error("Memory record ownership cannot be changed by upsert");
    return true;
  }
  upsertL0(record: L0Record, embedding?: Float32Array) {
    return this.put("memory_l0", l0RecordToDoc(record), embedding);
  }
  upsertL1(record: MemoryRecord, embedding?: Float32Array) {
    return this.put("memory_l1", l1RecordToDoc(record), embedding);
  }
  async insertL0Batch(records: L0Record[]): Promise<number> {
    await this.ensure();
    return this.db.transaction(async () => {
      for (const record of records)
        await this.put("memory_l0", l0RecordToDoc(record), undefined, true);
      return records.length;
    });
  }
  async updateL0Embedding(
    id: string,
    embedding: Float32Array,
  ): Promise<boolean> {
    await this.ensure();
    return (
      (
        await this.db.query(
          "UPDATE memory_l0 SET embedding=$1::vector WHERE id=$2",
          [vectorLiteral(embedding, this.dimensions), id],
        )
      ).rowCount === 1
    );
  }
  private async remove(table: string, w: Where): Promise<number> {
    await this.ensure();
    return (
      (await this.db.query(`DELETE FROM ${table} WHERE ${w.sql()}`, w.values))
        .rowCount ?? 0
    );
  }
  async deleteL0(id: string, filter?: IsolationFilter) {
    return (await this.remove("memory_l0", isolation(filter).ids([id]))) > 0;
  }
  async deleteL1(id: string, filter?: IsolationFilter) {
    return (await this.remove("memory_l1", isolation(filter).ids([id]))) > 0;
  }
  async deleteL1Batch(ids: string[], filter?: IsolationFilter) {
    await this.remove("memory_l1", isolation(filter).ids(ids));
    return true;
  }
  async deleteL0BySession(id: string, filter?: IsolationFilter) {
    return this.remove("memory_l0", isolation(filter).add("session_id", id));
  }
  private async count(table: string, w: Where): Promise<number> {
    await this.ensure();
    return Number(
      (
        await this.db.query<{ count: string }>(
          `SELECT count(*) FROM ${table} WHERE ${w.sql()}`,
          w.values,
        )
      ).rows[0].count,
    );
  }
  private l0Where(filter?: L0CountFilter) {
    return isolation(filter)
      .add("timestamp", filter?.timeStartMs, ">=")
      .add("timestamp", filter?.timeEndMs, "<=");
  }
  private l1Where(filter?: L1CountFilter) {
    return isolation(filter)
      .add("type", filter?.type)
      .add("updated_time", filter?.timeStart, ">=")
      .add("updated_time", filter?.timeEnd, "<=");
  }
  countL0(filter?: L0CountFilter) {
    return this.count("memory_l0", this.l0Where(filter));
  }
  countL1(filter?: L1CountFilter) {
    return this.count("memory_l1", this.l1Where(filter));
  }
  private async expire(
    table: string,
    field: string,
    cutoff: string,
  ): Promise<number> {
    const ms = Date.parse(cutoff);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return this.db.transaction(async () => {
      const w = new Where().add(field, ms, "<");
      const n = await this.count(table, w),
        total = await this.count(table, new Where());
      if (total && n / total > 0.8) return 0;
      return this.remove(table, w);
    }, true);
  }
  deleteL0Expired(cutoff: string) {
    return this.expire("memory_l0", "recorded_at_ms", cutoff);
  }
  deleteL1Expired(cutoff: string) {
    return this.expire("memory_l1", "updated_time_ms", cutoff);
  }
  private async rows<T>(
    table: string,
    w: Where,
    order: string,
    limit?: number,
    offset = 0,
    asc = false,
  ): Promise<T[]> {
    await this.ensure();
    const values = [...w.values];
    let sql = `SELECT data FROM ${table} WHERE ${w.sql()} ORDER BY ${w.field(order, true)} ${asc ? "ASC" : "DESC"}, id`;
    if (limit !== undefined) {
      values.push(pageLimit(limit));
      sql += ` LIMIT $${values.length}`;
    }
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error("Invalid query offset");
    values.push(offset);
    sql += ` OFFSET $${values.length}`;
    return (await this.db.query<{ data: T }>(sql, values)).rows.map(
      (r) => r.data,
    );
  }
  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    const w = isolation(filter).add("updated_time", filter?.updatedAfter, ">");
    if (filter?.recordIds) w.ids(filter.recordIds);
    return (await this.rows<L1Doc>("memory_l1", w, "updated_time_ms")).map(
      docToL1RecordRow,
    );
  }
  async queryL0ForL1(
    sessionKey: string,
    after?: number,
    limit = 50,
  ): Promise<L0QueryRow[]> {
    return (
      await this.rows<L0Doc>(
        "memory_l0",
        new Where()
          .add("session_key", sessionKey)
          .add("recorded_at_ms", after, ">"),
        "recorded_at_ms",
        limit,
        0,
        true,
      )
    ).map(docToL0QueryRow);
  }
  async queryL0GroupedBySessionId(
    key: string,
    after?: number,
    limit = 50,
  ): Promise<L0SessionGroup[]> {
    const groups = new Map<string, L0SessionGroup>();
    for (const r of await this.queryL0ForL1(key, after, limit)) {
      const key = JSON.stringify([
        r.team_id,
        r.user_id,
        r.agent_id,
        r.task_id,
        r.session_id,
      ]);
      let g = groups.get(key);
      if (!g) {
        g = {
          sessionId: r.session_id,
          teamId: r.team_id,
          userId: r.user_id,
          agentId: r.agent_id,
          taskId: r.task_id,
          messages: [],
        };
        groups.set(key, g);
      }
      g.messages.push({
        id: r.record_id,
        role: r.role,
        content: r.message_text,
        timestamp: r.timestamp,
        recordedAtMs: Date.parse(r.recorded_at) || 0,
      });
    }
    return [...groups.values()].sort(
      (a, b) => a.messages[0].timestamp - b.messages[0].timestamp,
    );
  }
  async getAllL0Texts() {
    return (
      await this.rows<L0Doc>("memory_l0", new Where(), "recorded_at_ms")
    ).map((d) => ({
      record_id: d._id,
      message_text: d.message_text,
      recorded_at: d.recorded_at,
    }));
  }
  async getAllL1Texts() {
    return (
      await this.rows<L1Doc>("memory_l1", new Where(), "updated_time_ms")
    ).map((d) => ({
      record_id: d._id,
      content: d.content,
      updated_time: d.updated_time,
    }));
  }
  async queryL0Paginated(f: L0PaginatedFilter): Promise<L0PaginatedResult> {
    return {
      total: await this.countL0(f),
      rows: (
        await this.rows<L0Doc>(
          "memory_l0",
          this.l0Where(f),
          "recorded_at_ms",
          f.limit,
          f.offset,
        )
      ).map(docToL0QueryRow),
    };
  }
  async queryL1Paginated(f: L1PaginatedFilter): Promise<L1PaginatedResult> {
    return {
      total: await this.countL1(f),
      rows: (
        await this.rows<L1Doc>(
          "memory_l1",
          this.l1Where(f),
          "updated_time_ms",
          f.limit,
          f.offset,
        )
      ).map(docToL1RecordRow),
    };
  }
  private async search<T>(
    table: string,
    embedding: Float32Array | undefined,
    text: string | undefined,
    limit: number,
    filter?: IsolationFilter,
  ): Promise<Array<{ data: T; score: number }>> {
    await this.ensure();
    const w = isolation(filter),
      values = [...w.values];
    let score: string, predicate: string;
    if (embedding) {
      values.push(vectorLiteral(embedding, this.dimensions));
      score = `GREATEST(0,1-(embedding <=> $${values.length}::vector))`;
      predicate = "embedding IS NOT NULL";
    } else {
      const tokens = extractQueryTokens(
        (text ?? "").replace(/\bOR\b/g, " ").replace(/"/g, " "),
      );
      if (!tokens.length) return [];
      // plainto_tsquery safely quotes each token; OR preserves upstream FTS recall semantics.
      values.push(tokens);
      const query = `(SELECT string_agg(plainto_tsquery('simple',term)::text, ' | ')::tsquery FROM unnest($${values.length}::text[]) term)`;
      score = `ts_rank_cd(search,${query},32)`;
      predicate = `search @@ ${query}`;
    }
    values.push(pageLimit(limit));
    return (
      await this.db.query<{ data: T; score: number }>(
        `SELECT data,${score} AS score FROM ${table} WHERE ${w.sql()} AND ${predicate} ORDER BY score DESC,id LIMIT $${values.length}`,
        values,
      )
    ).rows;
  }
  async searchL0Vector(
    v: Float32Array,
    k = 10,
    _q?: string,
    f?: IsolationFilter,
  ): Promise<L0SearchResult[]> {
    return (await this.search<L0Doc>("memory_l0", v, undefined, k, f)).map(
      (r) => ({ ...docToL0QueryRow(r.data), score: r.score }),
    );
  }
  async searchL1Vector(
    v: Float32Array,
    k = 10,
    _q?: string,
    f?: IsolationFilter,
  ): Promise<L1SearchResult[]> {
    return (await this.search<L1Doc>("memory_l1", v, undefined, k, f)).map(
      (r) => ({ ...docToL1RecordRow(r.data), score: r.score }),
    );
  }
  async searchL0Fts(q: string, k = 10, f?: IsolationFilter) {
    return (await this.search<L0Doc>("memory_l0", undefined, q, k, f)).map(
      (r) => ({ ...docToL0QueryRow(r.data), score: r.score }),
    );
  }
  async searchL1Fts(q: string, k = 10, f?: IsolationFilter) {
    return (await this.search<L1Doc>("memory_l1", undefined, q, k, f)).map(
      (r) => ({ ...docToL1RecordRow(r.data), score: r.score }),
    );
  }
  async reindexAll(
    embed: (s: string) => Promise<Float32Array>,
    progress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ) {
    let l0Count = 0,
      l1Count = 0;
    for (const [table, field, layer] of [
      ["memory_l1", "content", "L1"],
      ["memory_l0", "message_text", "L0"],
    ] as const) {
      const total = await this.count(table, new Where());
      let cursor = "",
        done = 0;
      while (true) {
        const batch = (
          await this.db.query<{ id: string; data: Record<string, string> }>(
            `SELECT id,data FROM ${table} WHERE id>$1 ORDER BY id LIMIT 100`,
            [cursor],
          )
        ).rows;
        if (!batch.length) break;
        for (const row of batch) {
          const vector = vectorLiteral(
            await embed(row.data[field]),
            this.dimensions,
          );
          await this.db.query(
            `UPDATE ${table} SET embedding=$1::vector WHERE id=$2 AND data=$3::jsonb`,
            [vector, row.id, JSON.stringify(row.data)],
          );
          cursor = row.id;
          progress?.(++done, total, layer);
        }
      }
      if (layer === "L1") l1Count = done;
      else l0Count = done;
    }
    return { l0Count, l1Count };
  }
  private profileWhere(f?: ProfileFilter) {
    return new Where()
      .add("type", f?.type)
      .add("teamId", f?.teamId)
      .add("agentId", f?.agentId)
      .add("userId", f?.userId)
      .prefix("filename", f?.pathPrefix);
  }
  pullProfiles() {
    return this.queryProfiles();
  }
  queryProfilesByIds(ids: string[]) {
    return this.docs.list<ProfileRecord>("profiles", new Where().ids(ids));
  }
  queryProfiles(f?: ProfileFilter) {
    return this.docs.list<ProfileRecord>("profiles", this.profileWhere(f));
  }
  countProfiles(f?: ProfileFilter) {
    return this.docs.count("profiles", this.profileWhere(f));
  }
  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    await this.ensure();
    await this.db.transaction(async () => {
      for (const r of records) {
        const old = await this.docs.get<ProfileRecord>("profiles", r.id);
        if (
          old &&
          ((old.teamId ?? "") !== (r.teamId ?? "") ||
            (old.agentId ?? "") !== (r.agentId ?? ""))
        )
          throw new Error("Profile ownership conflict");
        if (
          old &&
          r.baselineVersion !== undefined &&
          old.version !== r.baselineVersion
        )
          throw new Error("Profile optimistic-lock conflict");
        const { baselineVersion, ...record } = r;
        await this.docs.put("profiles", r.id, {
          ...record,
          teamId: r.teamId ?? "",
          agentId: r.agentId ?? "",
          userId: r.userId ?? "",
        });
      }
    }, true);
  }
  async deleteProfiles(ids: string[]) {
    await this.docs.delete("profiles", new Where().ids(ids));
  }
  async clearMemoryContent(
    f: MemoryContentClearFilter,
  ): Promise<MemoryContentClearResult> {
    if (!f.teamId?.trim() || !f.agentId?.trim())
      throw new Error("teamId and agentId are required to clear memory");
    await this.ensure();
    return this.db.transaction(
      async () => ({
        l0Deleted: await this.remove("memory_l0", isolation(f)),
        l1Deleted: await this.remove("memory_l1", isolation(f)),
        profilesDeleted: await this.docs.delete(
          "profiles",
          this.profileWhere(f),
        ),
      }),
      true,
    );
  }
  async appendAudit(entry: AuditEntry) {
    await this.docs.put("audit", entry.audit_id, entry);
  }
  queryAudit(f: AuditQueryFilter) {
    const w = new Where();
    for (const key of [
      "record_id",
      "layer",
      "action",
      "team_id",
      "agent_id",
      "user_id",
      "task_id",
    ] as const)
      w.add(key, f[key]);
    w.add("updated_at_ms", f.since_ms, ">=").add(
      "updated_at_ms",
      f.until_ms,
      "<=",
    );
    return this.docs.list<AuditEntry>("audit", w, {
      order: "updated_at_ms",
      numeric: true,
      limit: Math.min(f.limit ?? 100, 1000),
      offset: f.offset ?? 0,
    });
  }
}
