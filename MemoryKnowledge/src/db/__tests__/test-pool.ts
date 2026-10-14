/** Test-only node-postgres protocol adapter backed by real PostgreSQL WASM. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";

export class TestPool extends pg.Pool {
  readonly engine?: PGlite;
  private readonly network?: pg.Pool;
  private readonly schema = `knowledge_test_${randomUUID().replace(/-/g, "")}`;
  private readonly ready: Promise<unknown>;
  constructor() {
    super();
    const url = process.env.PG_TEST_URL;
    if (url) {
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("PG_TEST_URL must name a disposable *_test database");
      this.network = new pg.Pool({
        connectionString: url,
        max: 5,
        options: `-c search_path=${this.schema},public`,
      });
      this.ready = this.network.query(`CREATE SCHEMA "${this.schema}"`);
    } else {
      this.engine = new PGlite();
      this.ready = Promise.resolve();
    }
  }
  private previous: Promise<void> = Promise.resolve();
  override connect: any = async () => {
    await this.ready;
    if (this.network) return this.network.connect();
    const previous = this.previous;
    let release!: () => void;
    this.previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const client = new EventEmitter() as any;
    client.query = async (
      input: string | { text: string; rowMode?: string },
      values: unknown[] = [],
    ) => {
      const sql = typeof input === "string" ? input : input.text;
      const result =
        !values.length && sql.includes(";")
          ? (await this.engine!.exec(sql)).at(-1)!
          : await this.engine!.query(sql, values);
      return {
        rows:
          typeof input !== "string" && input.rowMode === "array"
            ? result.rows.map((row) =>
                result.fields.map(
                  (field) => (row as Record<string, unknown>)[field.name],
                ),
              )
            : result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
        fields: result.fields,
      };
    };
    client.release = release;
    return client;
  };
  override query: any = async (input: unknown, values?: unknown[]) => {
    const client = await this.connect();
    try {
      return await client.query(input, values);
    } finally {
      client.release();
    }
  };
  override end: any = async () => {
    await this.previous;
    await this.ready;
    if (this.network) {
      try {
        await this.network.query(`DROP SCHEMA "${this.schema}" CASCADE`);
      } finally {
        await this.network.end();
      }
    } else await this.engine!.close();
  };
}
