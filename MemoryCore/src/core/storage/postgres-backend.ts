/** Durable object bytes for profiles, conversations, checkpoints and skill resources. */
import type {
  IStorageBackend,
  PutObjectOptions,
  StorageObject,
  ListObjectsOptions,
  ListEntry,
} from "./types.js";
import type { PostgresDatabase } from "../store/postgres/client.js";
import { pageEntries } from "./list-page.js";
export class PostgresStorageBackend implements IStorageBackend {
  readonly type = "postgres" as const;
  private ready?: Promise<void>;
  constructor(private readonly db: PostgresDatabase) {}
  private init() {
    return (this.ready ??= this.db
      .transaction(async () => {
        await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_objects (
    key TEXT PRIMARY KEY, content BYTEA NOT NULL, content_type TEXT, metadata JSONB,
    modified_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
      }, true)
      .catch((e) => {
        this.ready = undefined;
        throw e;
      }));
  }
  async putObject(
    key: string,
    content: string | Buffer,
    opts?: PutObjectOptions,
  ) {
    await this.init();
    await this.db.query(
      `INSERT INTO memory_objects(key,content,content_type,metadata) VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT(key) DO UPDATE SET content=excluded.content,content_type=excluded.content_type,metadata=excluded.metadata,modified_at=now()`,
      [
        key,
        Buffer.isBuffer(content) ? content : Buffer.from(content),
        opts?.contentType ?? null,
        JSON.stringify(opts?.metadata ?? {}),
      ],
    );
  }
  async appendObject(key: string, content: string | Buffer) {
    await this.init();
    await this.db.query(
      `INSERT INTO memory_objects(key,content) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET content=memory_objects.content||excluded.content,modified_at=now()`,
      [key, Buffer.isBuffer(content) ? content : Buffer.from(content)],
    );
  }
  async getObject(key: string): Promise<StorageObject | null> {
    await this.init();
    const r = (
      await this.db.query<{
        content: Uint8Array;
        content_type: string | null;
        metadata: Record<string, string>;
        modified_at: Date;
      }>("SELECT * FROM memory_objects WHERE key=$1", [key])
    ).rows[0];
    return r
      ? {
          key,
          content: Buffer.from(r.content),
          contentType: r.content_type ?? undefined,
          metadata: r.metadata ?? {},
          lastModified: new Date(r.modified_at),
          size: r.content.byteLength,
        }
      : null;
  }
  async exists(key: string) {
    await this.init();
    return (
      (await this.db.query("SELECT 1 FROM memory_objects WHERE key=$1", [key]))
        .rows.length > 0
    );
  }
  async deleteObject(key: string) {
    await this.init();
    await this.db.query("DELETE FROM memory_objects WHERE key=$1", [key]);
  }
  async deleteByPrefix(prefix: string) {
    await this.init();
    return (
      (
        await this.db.query(
          "DELETE FROM memory_objects WHERE starts_with(key,$1)",
          [prefix],
        )
      ).rowCount ?? 0
    );
  }
  async listObjects(prefix: string, opts?: ListObjectsOptions) {
    await this.init();
    const rows = (
      await this.db.query<{ key: string; size: number; modified_at: Date }>(
        "SELECT key,octet_length(content) AS size,modified_at FROM memory_objects WHERE starts_with(key,$1) ORDER BY key",
        [prefix],
      )
    ).rows;
    const entries = new Map<string, ListEntry>();
    for (const row of rows) {
      const rest = row.key.slice(prefix.length),
        slash = rest.indexOf("/");
      const directory = !opts?.recursive && slash >= 0;
      const key = directory ? prefix + rest.slice(0, slash + 1) : row.key;
      if (!entries.has(key))
        entries.set(key, {
          key,
          size: directory ? 0 : row.size,
          lastModified: new Date(row.modified_at),
          isDirectory: directory,
        });
    }
    return pageEntries([...entries.values()], opts);
  }
}
