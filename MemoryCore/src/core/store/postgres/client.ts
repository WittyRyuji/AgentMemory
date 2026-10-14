/** Shared PostgreSQL infrastructure. All tenant identifiers are hashed, never SQL text. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Pool } from "pg";

export interface PgResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}
export interface PgConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<PgResult<T>>;
  release(): void;
}
export interface PgPool {
  connect(): Promise<PgConnection>;
  end(): Promise<void>;
}
export function instanceSchema(
  instanceId: string,
  purpose: "memory" | "metadata" = "memory",
): string {
  if (!instanceId.trim())
    throw new Error("PostgreSQL requires a nonempty instance ID");
  return `am_${purpose}_${createHash("sha256").update(instanceId).digest("hex").slice(0, 32)}`;
}

/** Convert the metadata adapter's portable positional parameters, preserving literals/comments. */
export function bindSql(sql: string): string {
  let index = 0;
  return sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?/g,
    (part) => (part === "?" ? `$${++index}` : part),
  );
}

export class PostgresDatabase {
  private readonly scope = new AsyncLocalStorage<PgConnection>();
  private initializing?: Promise<void>;
  private savepoint = 0;
  constructor(
    readonly pool: PgPool,
    readonly schema: string,
    private readonly ownsPool = false,
  ) {
    if (!/^am_(memory|metadata)_[a-f0-9]{32}$/.test(schema))
      throw new Error("Invalid PostgreSQL schema");
  }
  static connect(
    url: string,
    instanceId: string,
    purpose: "memory" | "metadata" = "memory",
  ) {
    if (!/^postgres(?:ql)?:\/\//.test(url))
      throw new Error("A PostgreSQL connection URL is required");
    const pool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Do not include connection errors/URLs in logs: they can contain credentials.
    pool.on("error", () => {});
    return new PostgresDatabase(
      pool as unknown as PgPool,
      instanceSchema(instanceId, purpose),
      true,
    );
  }
  async initialize(): Promise<void> {
    this.initializing ??= (async () => {
      const conn = await this.pool.connect();
      try {
        await conn.query("BEGIN");
        await conn.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [this.schema],
        );
        await conn.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
        await conn.query("COMMIT");
      } catch (error) {
        await conn.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        conn.release();
      }
    })().catch((error) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }
  async transaction<T>(fn: () => Promise<T>, serialize = false): Promise<T> {
    const nested = this.scope.getStore();
    if (nested) {
      const point = `sp_${++this.savepoint}`;
      await nested.query(`SAVEPOINT ${point}`);
      try {
        const result = await fn();
        await nested.query(`RELEASE SAVEPOINT ${point}`);
        return result;
      } catch (error) {
        await nested.query(`ROLLBACK TO SAVEPOINT ${point}`);
        await nested.query(`RELEASE SAVEPOINT ${point}`);
        throw error;
      }
    }
    await this.initialize();
    const conn = await this.pool.connect();
    try {
      await conn.query("BEGIN");
      await conn.query(`SET LOCAL search_path TO "${this.schema}", public`);
      if (serialize)
        await conn.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [this.schema],
        );
      const result = await this.scope.run(conn, fn);
      await conn.query("COMMIT");
      return result;
    } catch (error) {
      await conn.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }
  async query<T = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PgResult<T>> {
    const conn = this.scope.getStore();
    if (conn) return conn.query<T>(sql, values);
    return this.transaction(() => this.query<T>(sql, values));
  }
  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }
  async drop(): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
    } finally {
      conn.release();
    }
  }
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
