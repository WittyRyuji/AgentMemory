import type { PostgresDatabase } from "./client.js";

/** Parameterized JSONB predicates. Identifiers are internal schema fields, never request values. */
export class Where {
  readonly values: unknown[] = [];
  readonly parts: string[] = [];
  field(name: string, numeric = false): string {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name))
      throw new Error("Invalid document field");
    const field = `data->>'${name}'`;
    return numeric ? `(${field})::double precision` : `(${field})`;
  }
  add(
    name: string,
    value: unknown,
    operator: "=" | ">" | ">=" | "<" | "<=" = "=",
  ): this {
    if (value !== undefined) {
      this.values.push(value);
      this.parts.push(
        `${this.field(name, typeof value === "number")} ${operator} $${this.values.length}`,
      );
    }
    return this;
  }
  ids(ids: string[]): this {
    this.values.push(ids);
    this.parts.push(`id = ANY($${this.values.length}::text[])`);
    return this;
  }
  prefix(name: string, prefix: string | undefined): this {
    if (prefix !== undefined) {
      this.values.push(prefix);
      this.parts.push(
        `starts_with(${this.field(name)}, $${this.values.length})`,
      );
    }
    return this;
  }
  sql(): string {
    return this.parts.length ? this.parts.join(" AND ") : "TRUE";
  }
}

export class PostgresDocuments {
  constructor(readonly db: PostgresDatabase) {}
  async init(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_documents (
      kind TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (kind,id)
    ); CREATE INDEX IF NOT EXISTS memory_documents_data ON memory_documents USING GIN(data);`);
  }
  async put(kind: string, id: string, data: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO memory_documents(kind,id,data) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`,
      [kind, id, JSON.stringify(data)],
    );
  }
  async get<T>(kind: string, id: string): Promise<T | null> {
    return (
      (
        await this.db.query<{ data: T }>(
          "SELECT data FROM memory_documents WHERE kind=$1 AND id=$2",
          [kind, id],
        )
      ).rows[0]?.data ?? null
    );
  }
  async list<T>(
    kind: string,
    where = new Where(),
    options: {
      order?: string;
      numeric?: boolean;
      asc?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<T[]> {
    const values = [...where.values, kind];
    let sql = `SELECT data FROM memory_documents WHERE ${where.sql()} AND kind=$${values.length}`;
    sql += options.order
      ? ` ORDER BY ${where.field(options.order, options.numeric)} ${options.asc ? "ASC" : "DESC"}, id`
      : " ORDER BY id";
    if (options.limit !== undefined) {
      values.push(options.limit);
      sql += ` LIMIT $${values.length}`;
    }
    if (options.offset !== undefined) {
      values.push(options.offset);
      sql += ` OFFSET $${values.length}`;
    }
    return (await this.db.query<{ data: T }>(sql, values)).rows.map(
      (r) => r.data,
    );
  }
  async count(kind: string, where = new Where()): Promise<number> {
    const values = [...where.values, kind];
    return Number(
      (
        await this.db.query<{ count: string }>(
          `SELECT count(*) FROM memory_documents WHERE ${where.sql()} AND kind=$${values.length}`,
          values,
        )
      ).rows[0].count,
    );
  }
  async delete(kind: string, where: Where): Promise<number> {
    const values = [...where.values, kind];
    return (
      (
        await this.db.query(
          `DELETE FROM memory_documents WHERE ${where.sql()} AND kind=$${values.length}`,
          values,
        )
      ).rowCount ?? 0
    );
  }
}
