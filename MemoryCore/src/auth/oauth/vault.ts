import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PostgresDatabase,
  type PgConnection,
} from "../../core/store/postgres/client.js";
import { CredentialCipher } from "./crypto.js";
import {
  OAuthFailure,
  type LoginAttempt,
  type OAuthCredential,
} from "./types.js";
export interface ConnectionRecord {
  hostId: string;
  clientId?: string;
  subject?: string;
  credential?: OAuthCredential;
  status:
    | "signed_out"
    | "ready"
    | "consent_required"
    | "refreshing"
    | "login_required";
  retryAt?: number;
  lastError?: string;
  inferenceError?: "quota_limited" | "policy_denied" | "unavailable";
  inferenceRetryAt?: number;
}
export interface LockedConnection {
  read(): Promise<ConnectionRecord | undefined>;
  write(record: ConnectionRecord): Promise<void>;
  pending(attempt: LoginAttempt): Promise<void>;
  consume(state: string): Promise<LoginAttempt>;
  clearPending(): Promise<void>;
}
/** Dedicated OAuth schema. Credentials never enter memory, metadata, file, job or telemetry tables. */
export class PostgresOAuthVault {
  #cipher: CredentialCipher;
  #ready?: Promise<void>;
  constructor(
    readonly db: PostgresDatabase,
    key: string,
  ) {
    this.#cipher = new CredentialCipher(key);
  }
  async initialize(): Promise<void> {
    this.#ready ??= this.db
      .transaction(async () => {
        await this.db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [this.db.schema + ":oauth-schema"],
        );
        await this.db.exec(`CREATE TABLE IF NOT EXISTS oauth_connections (
        provider text NOT NULL, label text NOT NULL, encrypted text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,label));
        CREATE TABLE IF NOT EXISTS oauth_pending (
        provider text NOT NULL, label text NOT NULL, state_hash text NOT NULL,
        encrypted text NOT NULL, expires_at bigint NOT NULL, PRIMARY KEY(provider,label));`);
      })
      .catch(() => {
        this.#ready = undefined;
        throw new OAuthFailure("storage_error");
      });
    return this.#ready;
  }
  async withLock<T>(
    provider: string,
    label: string,
    fn: (connection: LockedConnection) => Promise<T>,
  ): Promise<T> {
    if (
      !/^[a-z0-9-]{1,64}$/.test(provider) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(label)
    )
      throw new OAuthFailure("configuration_error");
    await this.initialize();
    let connection: PgConnection;
    try {
      connection = await this.db.pool.connect();
    } catch {
      throw new OAuthFailure("storage_error");
    }
    const lock = `${this.db.schema}:${provider}:${label}`;
    const context = (kind: string) => `${lock}:${kind}`;
    const table = (name: string) => `"${this.db.schema}".${name}`;
    let locked = false;
    let destroy = false;
    try {
      const deadline = Date.now() + 30_000;
      do {
        const result = await connection.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [lock],
        );
        locked = result.rows[0]?.locked === true;
        if (!locked) await sleep(50);
      } while (!locked && Date.now() < deadline);
      if (!locked) throw new OAuthFailure("unavailable");
      // Session lock survives each auto-committed write, including the refresh intent BEFORE HTTP.
      return await fn({
        read: async () => {
          const row = (
            await connection.query<{ encrypted: string }>(
              `SELECT encrypted FROM ${table("oauth_connections")} WHERE provider=$1 AND label=$2`,
              [provider, label],
            )
          ).rows[0];
          return row
            ? this.#cipher.open<ConnectionRecord>(
                row.encrypted,
                context("credentials"),
              )
            : undefined;
        },
        write: async (record) => {
          await connection.query(
            `INSERT INTO ${table("oauth_connections")} (provider,label,encrypted) VALUES ($1,$2,$3)
            ON CONFLICT(provider,label) DO UPDATE SET encrypted=excluded.encrypted,updated_at=now()`,
            [
              provider,
              label,
              this.#cipher.seal(record, context("credentials")),
            ],
          );
        },
        pending: async (attempt) => {
          await connection.query(
            `DELETE FROM ${table("oauth_pending")} WHERE expires_at < $1`,
            [Date.now()],
          );
          await connection.query(
            `INSERT INTO ${table("oauth_pending")} (provider,label,state_hash,encrypted,expires_at) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT(provider,label) DO UPDATE SET state_hash=excluded.state_hash,encrypted=excluded.encrypted,expires_at=excluded.expires_at`,
            [
              provider,
              label,
              hash(attempt.state),
              this.#cipher.seal(attempt, context("pending")),
              attempt.expiresAt,
            ],
          );
        },
        consume: async (state) => {
          if (!/^[A-Za-z0-9_-]{43}$/.test(state))
            throw new OAuthFailure("invalid_callback");
          const row = (
            await connection.query<{ encrypted: string; expires_at: string }>(
              `DELETE FROM ${table("oauth_pending")} WHERE provider=$1 AND label=$2 AND state_hash=$3 RETURNING encrypted,expires_at`,
              [provider, label, hash(state)],
            )
          ).rows[0];
          if (!row || Number(row.expires_at) < Date.now())
            throw new OAuthFailure("invalid_callback");
          return this.#cipher.open<LoginAttempt>(
            row.encrypted,
            context("pending"),
          );
        },
        clearPending: async () => {
          await connection.query(
            `DELETE FROM ${table("oauth_pending")} WHERE provider=$1 AND label=$2`,
            [provider, label],
          );
        },
      });
    } catch (error) {
      if (error instanceof OAuthFailure) throw error;
      throw new OAuthFailure("storage_error");
    } finally {
      if (locked) {
        try {
          await connection.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lock],
          );
        } catch {
          destroy = true;
        }
      }
      connection.release(destroy);
    }
  }
  static freshRecord(): ConnectionRecord {
    return { hostId: `urn:uuid:${randomUUID()}`, status: "signed_out" };
  }
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
