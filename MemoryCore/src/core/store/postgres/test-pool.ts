/** Test-only harness. Set PG_TEST_URL to a disposable *_test database for native PG. */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { Pool } from "pg";
import type { PgPool, PgConnection, PgResult } from "./client.js";
export class TestPostgresPool implements PgPool {
  readonly pg?: PGlite;
  private readonly native?: Pool;
  private readonly schemas = new Set<string>();
  private previous: Promise<void> = Promise.resolve();
  private ended = false;
  constructor(embedded = false) {
    const url = !embedded && process.env.PG_TEST_URL;
    if (url) {
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error(
          "PG_TEST_URL must select a disposable database ending in _test",
        );
      this.native = new Pool({ connectionString: url, max: 4 });
    } else this.pg = new PGlite({ extensions: { vector } });
  }
  async connect(): Promise<PgConnection> {
    if (this.native) {
      const client = await this.native.connect();
      return {
        query: async <T>(
          sql: string,
          values: unknown[] = [],
        ): Promise<PgResult<T>> => {
          const result = await client.query(sql, values);
          const schema = sql.match(
            /^CREATE SCHEMA IF NOT EXISTS "(am_(?:memory|metadata)_[a-f0-9]{32})"$/,
          )?.[1];
          if (schema) this.schemas.add(schema);
          return result as unknown as PgResult<T>;
        },
        release: () => client.release(),
      };
    }
    const previous = this.previous;
    let unlock!: () => void;
    this.previous = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    return {
      query: async <T>(
        sql: string,
        values: unknown[] = [],
      ): Promise<PgResult<T>> => {
        if (!values.length && sql.includes(";")) {
          const results = await this.pg!.exec(sql);
          const last = results.at(-1);
          return {
            rows: (last?.rows ?? []) as T[],
            rowCount: last?.affectedRows ?? 0,
          };
        }
        const result = await this.pg!.query<T>(sql, values);
        return {
          rows: result.rows,
          rowCount: result.affectedRows ?? result.rows.length,
        };
      },
      release: unlock,
    };
  }
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.native) {
      try {
        for (const schema of this.schemas)
          await this.native.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await this.native.end();
      }
    } else await this.pg!.close();
  }
}
