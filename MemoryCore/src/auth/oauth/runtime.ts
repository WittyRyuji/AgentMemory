import { loadDatabaseConfig } from "../../db-config.js";
import { PostgresDatabase } from "../../core/store/postgres/client.js";
import { OAuthFailure } from "./types.js";
import { PostgresOAuthVault } from "./vault.js";
import { OAuthService } from "./service.js";
import { oauthProviders } from "./registry.js";
export interface OAuthConfig {
  adapter: string;
  account: string;
  vaultId: string;
  encryptionKeyEnv: string;
}
export function parseOAuthConfig(
  value: Record<string, unknown> = {},
): OAuthConfig {
  const field = (key: string, fallback: string) =>
    typeof value[key] === "string" ? (value[key] as string) : fallback;
  const config = {
    adapter: field("adapter", "openai-responses"),
    account: field("account", "default"),
    vaultId: field("vaultId", "agentmemory"),
    encryptionKeyEnv: field("encryptionKeyEnv", "AGENTMEMORY_OAUTH_KEY"),
  };
  if (
    !/^[a-z0-9-]{1,64}$/.test(config.adapter) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(config.account) ||
    !config.vaultId.trim() ||
    !/^[A-Z][A-Z0-9_]*$/.test(config.encryptionKeyEnv)
  )
    throw new OAuthFailure("configuration_error");
  return config;
}
const databases = new Map<string, PostgresDatabase>();
export function createOAuthRuntime(config: OAuthConfig) {
  const { auth, inference } = oauthProviders.resolve(config.adapter);
  const key = process.env[config.encryptionKeyEnv];
  const url = loadDatabaseConfig("core").url;
  if (!key || !url) throw new OAuthFailure("configuration_error");
  const dbKey = JSON.stringify([url, config.vaultId]);
  let db = databases.get(dbKey);
  if (!db) {
    db = PostgresDatabase.connect(url, config.vaultId, "oauth");
    databases.set(dbKey, db);
  }
  return {
    service: new OAuthService(
      new PostgresOAuthVault(db, key),
      auth,
      config.account,
    ),
    inference,
  };
}
export async function closeOAuthRuntimes() {
  const dbs = [...databases.values()];
  databases.clear();
  await Promise.all(dbs.map((db) => db.close()));
}
