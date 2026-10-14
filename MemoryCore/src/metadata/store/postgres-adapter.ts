/** PostgreSQL metadata adapter preserving the existing Panel/SDK metadata contract.
 * Ported from sqlite-adapter; transactions are connection-scoped and serialized per instance. */
import { PostgresDatabase, bindSql } from "../../core/store/postgres/client.js";
type SQLInputValue = string | number | bigint | null | Uint8Array;
import { mapTeamMemberWithProfile } from "./team-member-view.js";
import {
  generateId,
  generateRelationId,
  ID_PREFIX,
} from "../utils/id-generator.js";
const RELATION_ID_RETRY_LIMIT = 3;
import { generateUserKey } from "../utils/crypto.js";
import { isUserKeyExpired } from "../utils/user-key.js";
import {
  DEFAULT_GROUP_NAME,
  EXTRACTION_GROUP_NAME,
  InstanceUpstreamWriteConflictError,
} from "../types.js";
import type {
  UserEntity,
  UserKeyEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AclEntity,
  CreateUserInput,
  CreateUserKeyInput,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  AssetFilter,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  AgentFixedAssetCountRow,
  AssetType,
  ConfigParamEntity,
  UpsertConfigParamInput,
  ListConfigParamsFilter,
  UserSessionDefaultEntity,
  UpsertUserSessionDefaultInput,
  InstanceUpstreamConfigEntity,
  InstanceUpstreamConfigFilter,
  CreateInstanceUpstreamGroupInput,
  UpdateInstanceUpstreamGroupInput,
  ToggleInstanceUpstreamGroupInput,
  DeleteInstanceUpstreamGroupInput,
  SupportedAgent,
  GroupType,
  UpstreamMode,
} from "../types.js";
import { DEFAULT_PAGINATION } from "../pagination.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import { DuplicateUserKeyError, type IMetadataStore } from "./interface.js";
function nowIso(): string {
  return new Date().toISOString();
}
const PK_RETRY_LIMIT = 3;
/** Returns true if the error is a PostgreSQL unique constraint failure on a generated primary key column. */
function isPkCollision(err: unknown): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
  };
  return e.code === "23505" && !!e.constraint?.endsWith("_pkey");
}
function isUserKeyValueCollision(err: unknown): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
  };
  return e.code === "23505" && e.constraint === "meta_user_keys_key_value_key";
}
const isPostgresRelationIdCollision = isPkCollision;
const isStorePkCollision = isPkCollision;
async function runWithGeneratedRelationId<T>(
  fixedId: string | undefined,
  isCollision: (e: unknown) => boolean,
  insert: (id: string) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < RELATION_ID_RETRY_LIMIT; i++) {
    try {
      return await insert(fixedId ?? generateRelationId());
    } catch (e) {
      if (fixedId || !isCollision(e) || i === RELATION_ID_RETRY_LIMIT - 1)
        throw e;
    }
  }
  throw new Error("relation ID retry limit");
}
type Row = Record<string, SQLInputValue>;
export class PostgresMetadataStore implements IMetadataStore {
  private initialized = false;
  constructor(private readonly db: PostgresDatabase) {}
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.transaction(async () => {
      await this.createSchema();
    }, true);
    this.initialized = true;
  }
  async close(): Promise<void> {
    await this.db.close();
    this.initialized = false;
  }
  // ============================================================
  // Schema
  // ============================================================
  private async createSchema(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta_users (
        user_id TEXT PRIMARY KEY,
        password TEXT,
        auth_provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        raw_profile_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        user_type TEXT NOT NULL DEFAULT 'normal',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_users_system_admin ON meta_users(user_type) WHERE user_type = 'system_admin';
      CREATE INDEX IF NOT EXISTS idx_meta_users_auth_username ON meta_users(auth_provider, username);
      CREATE INDEX IF NOT EXISTS idx_meta_users_auth_external ON meta_users(auth_provider, external_id);
      CREATE INDEX IF NOT EXISTS idx_meta_users_email ON meta_users(email) WHERE email IS NOT NULL;
      CREATE TABLE IF NOT EXISTS meta_user_keys (
        key_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_value TEXT NOT NULL UNIQUE,
        name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_default INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_user_keys_user ON meta_user_keys(user_id, status);
      CREATE TABLE IF NOT EXISTS meta_teams (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS meta_team_members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        UNIQUE(team_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS meta_agents (
        agent_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        prompt TEXT,
        visibility TEXT NOT NULL DEFAULT 'team',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_agents_team_status ON meta_agents(team_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS meta_tasks (
        task_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        auto_assign_floating_assets INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_tasks_team_status ON meta_tasks(team_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS meta_task_agents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role_in_task TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        UNIQUE(task_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS meta_participation_logs (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta_assets (
        asset_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        owner_user_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        visibility TEXT NOT NULL DEFAULT 'team',
        status TEXT NOT NULL DEFAULT 'draft',
        confidence REAL,
        expires_at TEXT,
        last_used_at TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        content_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_assets_team_status ON meta_assets(team_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS meta_agent_fixed_assets (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        injection_mode TEXT NOT NULL DEFAULT 'summary',
        priority INTEGER NOT NULL DEFAULT 50,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS meta_asset_acl (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        effect TEXT NOT NULL DEFAULT 'allow',
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(asset_id, subject_type, subject_id, permission)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_users_created ON meta_users(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_user_keys_user_created ON meta_user_keys(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_teams_created ON meta_teams(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_members_user_status ON meta_team_members(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_meta_members_team_status_joined ON meta_team_members(team_id, status, joined_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_agents_owner_status_created ON meta_agents(owner_user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_tasks_creator_status_created ON meta_tasks(creator_user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_task_agents_task_status_created ON meta_task_agents(task_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_created ON meta_participation_logs(team_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_task_agent_created ON meta_participation_logs(team_id, task_id, agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_user_created ON meta_participation_logs(team_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_dims_created ON meta_participation_logs(team_id, task_id, agent_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_fixed_agent_prio_created ON meta_agent_fixed_assets(agent_id, priority DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_acl_asset_created ON meta_asset_acl(asset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_acl_subject_created ON meta_asset_acl(subject_type, subject_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS meta_config_params (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'user')),
        user_id TEXT,
        module TEXT NOT NULL,
        param_name TEXT NOT NULL,
        param_value TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'global' AND user_id IS NULL) OR
          (scope = 'user' AND user_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_config_params_global
        ON meta_config_params(module, param_name) WHERE scope = 'global';
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_config_params_user
        ON meta_config_params(user_id, module, param_name) WHERE scope = 'user';
      CREATE INDEX IF NOT EXISTS idx_meta_config_params_module
        ON meta_config_params(module);

      -- UserSessionDefault (v3.3): 用户级 session 默认 (team/agent/task) 三元组。
      -- user_id PK 天然保证"至多一条"。task_id 存真实 id 或字面量 "default"
      -- (与 Proxy sessionInit.defaultTaskId 契约一致, 见 types.ts::DEFAULT_TASK_SENTINEL)。
      CREATE TABLE IF NOT EXISTS meta_user_session_defaults (
        user_id    TEXT PRIMARY KEY,
        team_id    TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        task_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES meta_users(user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_meta_user_session_defaults_team
        ON meta_user_session_defaults(team_id);
      CREATE INDEX IF NOT EXISTS idx_meta_user_session_defaults_agent
        ON meta_user_session_defaults(agent_id);
      CREATE INDEX IF NOT EXISTS idx_meta_user_session_defaults_task
        ON meta_user_session_defaults(task_id);

      -- v2 (模型组) 结构。v1 未真正投产,直接 DROP + 重建,不留兼容 shim。
      -- 详见 docs/design/2026-08-25-instance-upstream-config.md §5.1。
      CREATE TABLE IF NOT EXISTS meta_instance_upstream_config (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        group_id TEXT NOT NULL,
        group_type TEXT NOT NULL CHECK (group_type IN ('default','custom','extraction')),
        name TEXT NOT NULL DEFAULT '',
        agents TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'official' CHECK (mode IN ('official','custom_unified','custom_passthrough')),
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        supported_agents_snapshot TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(group_id)
      );
      -- default / extraction 单例约束(每实例最多 1 行)。
      CREATE UNIQUE INDEX IF NOT EXISTS ux_iuc_singleton_group_type
        ON meta_instance_upstream_config(group_type)
        WHERE group_type IN ('default','extraction');
    `);
  }
  private async insertUserKeyRow(input: {
    user_id: string;
    key_value: string;
    name?: string | null;
    is_default?: boolean;
    expires_at?: string | null;
    created_at?: string;
    metadata_json?: string;
  }): Promise<UserKeyEntity> {
    const now = input.created_at ?? nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const keyId = generateId(ID_PREFIX.userKey);
      try {
        await this.run(
          `INSERT INTO meta_user_keys
            (key_id, user_id, key_value, name, status, is_default, last_used_at, expires_at, created_at, revoked_at, metadata_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          keyId,
          input.user_id,
          input.key_value,
          input.name ?? null,
          "active",
          input.is_default ? 1 : 0,
          null,
          input.expires_at ?? null,
          now,
          null,
          input.metadata_json ?? "{}",
        );
        return (await this.getUserKeyById(keyId))!;
      } catch (err) {
        if (isPkCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("user key PK collision after max retries");
  }
  private mapUserKey(row: Row | null | undefined): UserKeyEntity | null {
    if (!row) return null;
    return {
      key_id: String(row.key_id),
      user_id: String(row.user_id),
      key_value: String(row.key_value),
      name: row.name != null ? String(row.name) : null,
      status: String(row.status) as UserKeyEntity["status"],
      is_default: Number(row.is_default) === 1,
      last_used_at: row.last_used_at != null ? String(row.last_used_at) : null,
      expires_at: row.expires_at != null ? String(row.expires_at) : null,
      created_at: String(row.created_at),
      revoked_at: row.revoked_at != null ? String(row.revoked_at) : null,
      metadata_json: String(row.metadata_json ?? "{}"),
    };
  }
  private async tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn, true);
  }
  private async withImmediateTx<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn, true);
  }
  private async get<T = Row>(
    sql: string,
    ...params: SQLInputValue[]
  ): Promise<T | null> {
    return (await this.db.query<T>(bindSql(sql), params)).rows[0] ?? null;
  }
  private async all<T = Row>(
    sql: string,
    ...params: SQLInputValue[]
  ): Promise<T[]> {
    return (await this.db.query<T>(bindSql(sql), params)).rows;
  }
  private async run(sql: string, ...params: SQLInputValue[]): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.query(bindSql(sql), params);
    });
  }
  private async selectList<T>(
    countSql: string,
    countParams: SQLInputValue[],
    dataSql: string,
    dataParams: SQLInputValue[],
    pagination: PaginationParams | null | undefined,
    mapper: (row: Row) => T | null,
  ): Promise<ListPage<T>> {
    const totalRow = await this.get<{
      c: number;
    }>(countSql, ...countParams);
    const total = Number(totalRow?.c ?? 0);
    const p = pagination ?? DEFAULT_PAGINATION;
    const rows = await this.all(
      `${dataSql} LIMIT ? OFFSET ?`,
      ...dataParams,
      p.limit,
      p.offset,
    );
    const items: T[] = [];
    for (const r of rows) {
      const mapped = mapper(r);
      if (mapped) items.push(mapped);
    }
    return { items, total };
  }
  // ============================================================
  // User
  // ============================================================
  async createUser(input: CreateUserInput): Promise<UserEntity> {
    const now = nowIso();
    const defaultKeyValue = input.default_key_value ?? generateUserKey();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const userId = input.user_id ?? generateId(ID_PREFIX.user);
      try {
        await this.tx(async () => {
          await this.run(
            `INSERT INTO meta_users
              (user_id, password, auth_provider, external_id, username,
               display_name, email, raw_profile_json, status, user_type, created_at, updated_at, metadata_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            userId,
            input.password ?? null,
            input.auth_provider as string,
            input.external_id as string,
            input.username as string,
            input.display_name ?? null,
            input.email ?? null,
            input.raw_profile_json ?? "{}",
            input.status ?? "active",
            input.user_type ?? "normal",
            now,
            now,
            input.metadata_json ?? "{}",
          );
          await this.insertUserKeyRow({
            user_id: userId,
            key_value: defaultKeyValue,
            is_default: true,
            created_at: now,
          });
        });
        return (await this.getUserById(userId))!;
      } catch (err) {
        // 调用方显式指定 default_key_value 时命中 UNIQUE：翻译为业务错(HTTP 409)。
        // 不 retry：随机 key_value 生成场景下 192bit 熵不可能碰撞，能到这里的只有显式指定。
        if (isUserKeyValueCollision(err)) {
          throw new DuplicateUserKeyError(defaultKeyValue);
        }
        if (isPkCollision(err) && !input.user_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }
  async getUserById(userId: string): Promise<UserEntity | null> {
    return this.mapUser(
      await this.get("SELECT * FROM meta_users WHERE user_id = ?", userId),
    );
  }
  async getUserByKey(userKey: string): Promise<UserEntity | null> {
    const keyRow = this.mapUserKey(
      await this.get(
        "SELECT * FROM meta_user_keys WHERE key_value = ? AND status = 'active'",
        userKey,
      ),
    );
    if (!keyRow || isUserKeyExpired(keyRow.expires_at)) return null;
    await this.touchUserKeyUsage(keyRow.key_id);
    return await this.getUserById(keyRow.user_id);
  }
  async getDefaultUserKey(userId: string): Promise<UserKeyEntity | null> {
    return this.mapUserKey(
      await this.get(
        "SELECT * FROM meta_user_keys WHERE user_id = ? AND is_default = 1 AND status = 'active' LIMIT 1",
        userId,
      ),
    );
  }
  async getUserByUsername(
    authProvider: string,
    username: string,
  ): Promise<UserEntity | null> {
    return this.mapUser(
      await this.get(
        "SELECT * FROM meta_users WHERE auth_provider = ? AND username = ?",
        authProvider,
        username,
      ),
    );
  }
  async getUserByEmail(email: string): Promise<UserEntity | null> {
    return this.mapUser(
      await this.get("SELECT * FROM meta_users WHERE email = ?", email),
    );
  }
  async getUserByExternalId(
    authProvider: string,
    externalId: string,
  ): Promise<UserEntity | null> {
    return this.mapUser(
      await this.get(
        "SELECT * FROM meta_users WHERE auth_provider = ? AND external_id = ?",
        authProvider,
        externalId,
      ),
    );
  }
  async updateUser(
    userId: string,
    patch: Partial<UserEntity>,
  ): Promise<UserEntity | null> {
    // external_id / auth_provider：外部认证（如 WOA）绑定存量账号时写入，
    // 用于下次登录判断是否初次。白名单漏掉 auth_provider 会导致绑定"看似成功、
    // 实际没写域"，下次按域反查落空 → 401，属静默失效，务必保留。
    const allowed = [
      "password",
      "display_name",
      "email",
      "raw_profile_json",
      "status",
      "metadata_json",
      "username",
      "external_id",
      "auth_provider",
    ] as const;
    await this.applyUpdate("meta_users", "user_id", userId, allowed, patch);
    return await this.getUserById(userId);
  }
  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_users", "user_id", userIds);
    if (result.deleted_ids.length > 0) {
      const ph = result.deleted_ids.map(() => "?").join(",");
      await this.run(
        `DELETE FROM meta_user_keys WHERE user_id IN (${ph})`,
        ...result.deleted_ids,
      );
      await this.run(
        `DELETE FROM meta_team_members WHERE user_id IN (${ph})`,
        ...result.deleted_ids,
      );
      await this.run(
        `DELETE FROM meta_asset_acl WHERE subject_type = 'user' AND subject_id IN (${ph})`,
        ...result.deleted_ids,
      );
    }
    return result;
  }
  async listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    let base =
      "FROM meta_users u JOIN meta_team_members m ON m.user_id = u.user_id WHERE m.team_id = ? AND m.status = 'active'";
    const params: SQLInputValue[] = [teamId];
    if (filter?.user_ids?.length) {
      base += ` AND u.user_id IN (${filter.user_ids.map(() => "?").join(",")})`;
      params.push(...filter.user_ids);
    }
    if (filter?.username) {
      base += " AND u.username = ?";
      params.push(filter.username);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      params,
      `SELECT u.* ${base} ORDER BY u.created_at DESC`,
      params,
      pagination,
      (r) => this.mapUser(r),
    );
  }
  async listUsers(
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    let where = "WHERE 1=1";
    const params: SQLInputValue[] = [];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.user_type) {
      where += " AND user_type = ?";
      params.push(filter.user_type);
    }
    if (filter?.user_ids?.length) {
      where += ` AND user_id IN (${filter.user_ids.map(() => "?").join(",")})`;
      params.push(...filter.user_ids);
    }
    if (filter?.username) {
      where += " AND username = ?";
      params.push(filter.username);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c FROM meta_users ${where}`,
      params,
      `SELECT * FROM meta_users ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapUser(r),
    );
  }
  async countUsers(): Promise<number> {
    const row = await this.get<{
      c: number;
    }>("SELECT COUNT(*) AS c FROM meta_users");
    return row?.c ?? 0;
  }
  async countSystemAdmins(): Promise<number> {
    const row = await this.get<{
      c: number;
    }>("SELECT COUNT(*) AS c FROM meta_users WHERE user_type = 'system_admin'");
    return row?.c ?? 0;
  }
  async countTeams(): Promise<number> {
    const row = await this.get<{
      c: number;
    }>("SELECT COUNT(*) AS c FROM meta_teams");
    return row?.c ?? 0;
  }
  // ============================================================
  // UserKey
  // ============================================================
  async createUserKey(input: CreateUserKeyInput): Promise<UserKeyEntity> {
    if (input.is_default) {
      await this.run(
        "UPDATE meta_user_keys SET is_default = 0 WHERE user_id = ? AND status = 'active'",
        input.user_id,
      );
    }
    const keyValue = input.key_value ?? generateUserKey();
    return await this.insertUserKeyRow({
      user_id: input.user_id,
      key_value: keyValue,
      name: input.name,
      is_default: input.is_default ?? false,
      expires_at: input.expires_at,
      metadata_json: input.metadata_json,
    });
  }
  async getUserKeyById(keyId: string): Promise<UserKeyEntity | null> {
    return this.mapUserKey(
      await this.get("SELECT * FROM meta_user_keys WHERE key_id = ?", keyId),
    );
  }
  async listUserKeys(
    userId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<UserKeyEntity>> {
    const base = "FROM meta_user_keys WHERE user_id = ?";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [userId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [userId],
      pagination,
      (r) => this.mapUserKey(r),
    );
  }
  async countActiveUserKeys(userId: string): Promise<number> {
    const row = await this.get(
      "SELECT COUNT(*) AS c FROM meta_user_keys WHERE user_id = ? AND status = 'active'",
      userId,
    );
    return Number(row?.c ?? 0);
  }
  async revokeUserKey(
    keyId: string,
    options?: {
      promoteNextDefault?: boolean;
    },
  ): Promise<UserKeyEntity | null> {
    const promoteNextDefault = options?.promoteNextDefault ?? true;
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;
    if (existing.is_default && promoteNextDefault) {
      await this.run(
        "UPDATE meta_user_keys SET is_default = 0 WHERE key_id = ?",
        keyId,
      );
      const next = await this.get(
        `SELECT * FROM meta_user_keys WHERE user_id = ? AND status = 'active' AND key_id != ? ORDER BY created_at ASC LIMIT 1`,
        existing.user_id,
        keyId,
      );
      if (next) {
        await this.run(
          "UPDATE meta_user_keys SET is_default = 1 WHERE key_id = ?",
          String(next.key_id),
        );
      }
    }
    await this.run("DELETE FROM meta_user_keys WHERE key_id = ?", keyId);
    return existing;
  }
  async updateUserKey(
    keyId: string,
    patch: Partial<
      Pick<
        UserKeyEntity,
        "name" | "expires_at" | "is_default" | "metadata_json"
      >
    >,
  ): Promise<UserKeyEntity | null> {
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;
    if (patch.is_default === true) {
      await this.run(
        "UPDATE meta_user_keys SET is_default = 0 WHERE user_id = ? AND status = 'active'",
        existing.user_id,
      );
    }
    const allowed = [
      "name",
      "expires_at",
      "is_default",
      "metadata_json",
    ] as const;
    await this.applyUpdate("meta_user_keys", "key_id", keyId, allowed, {
      ...patch,
      is_default:
        patch.is_default === undefined ? undefined : patch.is_default ? 1 : 0,
    } as Partial<UserKeyEntity>);
    return await this.getUserKeyById(keyId);
  }
  async touchUserKeyUsage(keyId: string): Promise<void> {
    await this.run(
      "UPDATE meta_user_keys SET last_used_at = ? WHERE key_id = ?",
      nowIso(),
      keyId,
    );
  }
  async revokeAllUserKeysForUser(userId: string): Promise<void> {
    await this.run(
      "DELETE FROM meta_user_keys WHERE user_id = ? AND status = 'active'",
      userId,
    );
  }
  // ============================================================
  // Team（自动 admin 成员）
  // ============================================================
  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const teamId = input.team_id ?? generateId(ID_PREFIX.team);
      try {
        return await this.tx(async () => {
          await this.run(
            `INSERT INTO meta_teams
              (team_id, name, description, owner_user_id, status, created_at, updated_at, metadata_json)
             VALUES (?,?,?,?,?,?,?,?)`,
            teamId,
            input.name,
            input.description ?? null,
            input.owner_user_id,
            input.status ?? "active",
            now,
            now,
            input.metadata_json ?? "{}",
          );
          await this.run(
            `INSERT INTO meta_team_members (id, team_id, user_id, role, joined_at, status)
             VALUES (?,?,?,?,?,?)`,
            generateRelationId(),
            teamId,
            input.owner_user_id,
            "admin",
            now,
            "active",
          );
          return (await this.getTeamById(teamId))!;
        });
      } catch (err) {
        if (isStorePkCollision(err) && !input.team_id) continue;
        if (isPostgresRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }
  async getTeamById(teamId: string): Promise<TeamEntity | null> {
    return this.mapTeam(
      await this.get("SELECT * FROM meta_teams WHERE team_id = ?", teamId),
    );
  }
  async updateTeam(
    teamId: string,
    patch: Partial<TeamEntity>,
  ): Promise<TeamEntity | null> {
    const allowed = ["name", "description", "status", "metadata_json"] as const;
    await this.applyUpdate("meta_teams", "team_id", teamId, allowed, patch);
    return await this.getTeamById(teamId);
  }
  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_teams", "team_id", teamIds);
    if (result.deleted_ids.length > 0) {
      const ph = result.deleted_ids.map(() => "?").join(",");
      await this.run(
        `DELETE FROM meta_team_members WHERE team_id IN (${ph})`,
        ...result.deleted_ids,
      );
      await this.run(
        `DELETE FROM meta_agents WHERE team_id IN (${ph})`,
        ...result.deleted_ids,
      );
      await this.run(
        `DELETE FROM meta_tasks WHERE team_id IN (${ph})`,
        ...result.deleted_ids,
      );
      await this.run(
        `DELETE FROM meta_assets WHERE team_id IN (${ph})`,
        ...result.deleted_ids,
      );
    }
    return result;
  }
  async listTeamsByUser(
    userId: string,
    pagination?: PaginationParams | null,
    filter?: {
      name?: string;
    },
  ): Promise<ListPage<TeamEntity>> {
    let base =
      "FROM meta_teams t JOIN meta_team_members m ON m.team_id = t.team_id WHERE m.user_id = ? AND m.status = 'active'";
    const params: SQLInputValue[] = [userId];
    if (filter?.name) {
      base += " AND t.name = ?";
      params.push(filter.name);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      params,
      `SELECT t.* ${base} ORDER BY t.created_at DESC`,
      params,
      pagination,
      (r) => this.mapTeam(r),
    );
  }
  // ============================================================
  // TeamMember
  // ============================================================
  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMemberEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(
      input.id,
      isPostgresRelationIdCollision,
      async (id) => {
        await this.run(
          `INSERT INTO meta_team_members (id, team_id, user_id, role, joined_at, status)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status`,
          id,
          input.team_id,
          input.user_id,
          input.role ?? "member",
          now,
          input.status ?? "active",
        );
      },
    );
    return (await this.getTeamMember(input.team_id, input.user_id))!;
  }
  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.run(
      "DELETE FROM meta_team_members WHERE team_id = ? AND user_id = ?",
      teamId,
      userId,
    );
  }
  async listTeamMembers(
    teamId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TeamMemberEntity>> {
    const base =
      "FROM meta_team_members WHERE team_id = ? AND status = 'active'";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [teamId],
      `SELECT * ${base} ORDER BY joined_at DESC`,
      [teamId],
      pagination,
      (r) => r as unknown as TeamMemberEntity,
    );
  }
  async getTeamMember(
    teamId: string,
    userId: string,
  ): Promise<TeamMemberEntity | null> {
    return await this.get<TeamMemberEntity>(
      "SELECT * FROM meta_team_members WHERE team_id = ? AND user_id = ?",
      teamId,
      userId,
    );
  }
  async listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TeamMemberView>> {
    const base =
      "FROM meta_team_members m LEFT JOIN meta_users u ON u.user_id = m.user_id WHERE m.team_id = ? AND m.status = 'active'";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [teamId],
      `SELECT m.id, m.team_id, m.user_id, m.role, m.joined_at, m.status, COALESCE(u.username, '') AS username ${base} ORDER BY m.joined_at DESC`,
      [teamId],
      pagination,
      (r) =>
        mapTeamMemberWithProfile(
          r as unknown as TeamMemberEntity & {
            username?: string;
          },
        ),
    );
  }
  async getTeamMemberWithProfile(
    teamId: string,
    userId: string,
  ): Promise<TeamMemberView | null> {
    const row = await this.get<
      TeamMemberEntity & {
        username?: string;
      }
    >(
      `SELECT m.id, m.team_id, m.user_id, m.role, m.joined_at, m.status, COALESCE(u.username, '') AS username
       FROM meta_team_members m
       LEFT JOIN meta_users u ON u.user_id = m.user_id
       WHERE m.team_id = ? AND m.user_id = ?`,
      teamId,
      userId,
    );
    return row ? mapTeamMemberWithProfile(row) : null;
  }
  // ============================================================
  // Agent
  // ============================================================
  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const agentId = input.agent_id ?? generateId(ID_PREFIX.agent);
      try {
        await this.run(
          `INSERT INTO meta_agents
            (agent_id, team_id, owner_user_id, name, description, prompt, visibility, status, created_at, updated_at, metadata_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          agentId,
          input.team_id,
          input.owner_user_id,
          input.name,
          input.description ?? null,
          input.prompt ?? null,
          input.visibility ?? "team",
          input.status ?? "active",
          now,
          now,
          input.metadata_json ?? "{}",
        );
        return (await this.getAgentById(agentId))!;
      } catch (err) {
        if (isPkCollision(err) && !input.agent_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }
  async getAgentById(agentId: string): Promise<AgentEntity | null> {
    return this.mapAgent(
      await this.get("SELECT * FROM meta_agents WHERE agent_id = ?", agentId),
    );
  }
  async updateAgent(
    agentId: string,
    patch: Partial<AgentEntity>,
  ): Promise<AgentEntity | null> {
    const allowed = [
      "name",
      "description",
      "prompt",
      "visibility",
      "status",
      "metadata_json",
    ] as const;
    await this.applyUpdate("meta_agents", "agent_id", agentId, allowed, patch);
    return await this.getAgentById(agentId);
  }
  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    const existingAgents = (
      await Promise.all(
        agentIds.map(async (agentId) => await this.getAgentById(agentId)),
      )
    ).filter((agent): agent is AgentEntity => !!agent);
    const selfMemoryByAgent = new Map(
      existingAgents.map((agent) => [
        agent.agent_id,
        buildChatMemoryAssetId(agent.team_id, agent.agent_id),
      ]),
    );
    const result = await this.batchDelete("meta_agents", "agent_id", agentIds);
    if (result.deleted_ids.length > 0) {
      const ph = result.deleted_ids.map(() => "?").join(",");
      await this.run(
        `DELETE FROM meta_task_agents WHERE agent_id IN (${ph})`,
        ...result.deleted_ids,
      );
      await this.run(
        `DELETE FROM meta_agent_fixed_assets WHERE agent_id IN (${ph})`,
        ...result.deleted_ids,
      );
      const selfMemoryAssetIds = result.deleted_ids
        .map((agentId) => selfMemoryByAgent.get(agentId))
        .filter((assetId): assetId is string => !!assetId);
      if (selfMemoryAssetIds.length > 0) {
        await this.deleteAssets(selfMemoryAssetIds);
      }
    }
    return result;
  }
  async listAgentsByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: AgentFilter,
  ): Promise<ListPage<AgentEntity>> {
    let where = "WHERE team_id = ?";
    const params: SQLInputValue[] = [teamId];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.owner_user_id) {
      where += " AND owner_user_id = ?";
      params.push(filter.owner_user_id);
    }
    if (filter?.name) {
      where += " AND name = ?";
      params.push(filter.name);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c FROM meta_agents ${where}`,
      params,
      `SELECT * FROM meta_agents ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapAgent(r),
    );
  }
  async listAgentsByOwner(
    userId: string,
    pagination?: PaginationParams | null,
    filter?: AgentFilter,
  ): Promise<ListPage<AgentEntity>> {
    let where = "WHERE owner_user_id = ?";
    const params: SQLInputValue[] = [userId];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.name) {
      where += " AND name = ?";
      params.push(filter.name);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c FROM meta_agents ${where}`,
      params,
      `SELECT * FROM meta_agents ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapAgent(r),
    );
  }
  // ============================================================
  // Task（含 linkAgents 原子）
  // ============================================================
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const taskId = input.task_id ?? generateId(ID_PREFIX.task);
      try {
        return await this.tx(async () => {
          await this.run(
            `INSERT INTO meta_tasks
              (task_id, team_id, creator_user_id, title, description, source_type, source_url,
               status, auto_assign_floating_assets, risk_level, created_at, updated_at, metadata_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            taskId,
            input.team_id,
            input.creator_user_id,
            input.title,
            input.description ?? null,
            input.source_type ?? "manual",
            input.source_url ?? null,
            input.status ?? "running",
            input.auto_assign_floating_assets ? 1 : 0,
            input.risk_level ?? null,
            now,
            now,
            input.metadata_json ?? "{}",
          );
          for (const link of input.linked_agents ?? []) {
            await this.run(
              `INSERT INTO meta_task_agents (id, task_id, agent_id, role_in_task, status, created_at)
               VALUES (?,?,?,?,?,?)`,
              generateRelationId(),
              taskId,
              link.agent_id,
              link.role_in_task ?? null,
              "active",
              now,
            );
          }
          return (await this.getTaskById(taskId))!;
        });
      } catch (err) {
        if (isStorePkCollision(err) && !input.task_id) continue;
        if (isPostgresRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }
  async getTaskById(taskId: string): Promise<TaskEntity | null> {
    return this.mapTask(
      await this.get("SELECT * FROM meta_tasks WHERE task_id = ?", taskId),
    );
  }
  async updateTask(
    taskId: string,
    patch: Partial<TaskEntity>,
  ): Promise<TaskEntity | null> {
    const allowed = [
      "title",
      "description",
      "source_type",
      "source_url",
      "status",
      "auto_assign_floating_assets",
      "risk_level",
      "metadata_json",
    ] as const;
    const normalized: Record<string, SQLInputValue> = {};
    for (const k of allowed) {
      if (k in patch && (patch as Record<string, unknown>)[k] !== undefined) {
        const v = (patch as Record<string, unknown>)[k];
        normalized[k] =
          k === "auto_assign_floating_assets"
            ? v
              ? 1
              : 0
            : (v as SQLInputValue);
      }
    }
    await this.applyUpdateRaw("meta_tasks", "task_id", taskId, normalized);
    return await this.getTaskById(taskId);
  }
  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_tasks", "task_id", taskIds);
    if (result.deleted_ids.length > 0) {
      const ph = result.deleted_ids.map(() => "?").join(",");
      await this.run(
        `DELETE FROM meta_task_agents WHERE task_id IN (${ph})`,
        ...result.deleted_ids,
      );
    }
    return result;
  }
  async listTasksByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: TaskFilter,
  ): Promise<ListPage<TaskEntity>> {
    let where = "WHERE team_id = ?";
    const params: SQLInputValue[] = [teamId];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.creator_user_id) {
      where += " AND creator_user_id = ?";
      params.push(filter.creator_user_id);
    }
    if (filter?.title) {
      where += " AND title = ?";
      params.push(filter.title);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c FROM meta_tasks ${where}`,
      params,
      `SELECT * FROM meta_tasks ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapTask(r),
    );
  }
  async listTasks(
    filter: TaskFilter,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TaskEntity>> {
    let where = "WHERE 1=1";
    const params: SQLInputValue[] = [];
    if (filter.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter.creator_user_id) {
      where += " AND creator_user_id = ?";
      params.push(filter.creator_user_id);
    }
    if (filter.title) {
      where += " AND title = ?";
      params.push(filter.title);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c FROM meta_tasks ${where}`,
      params,
      `SELECT * FROM meta_tasks ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapTask(r),
    );
  }
  // ============================================================
  // TaskAgent
  // ============================================================
  async linkTaskAgent(
    taskId: string,
    agentId: string,
    roleInTask?: string,
  ): Promise<TaskAgentEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(
      undefined,
      isPostgresRelationIdCollision,
      async (id) => {
        await this.run(
          `INSERT INTO meta_task_agents (id, task_id, agent_id, role_in_task, status, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(task_id, agent_id) DO UPDATE SET role_in_task = excluded.role_in_task, status = 'active'`,
          id,
          taskId,
          agentId,
          roleInTask ?? null,
          "active",
          now,
        );
      },
    );
    return (await this.get<TaskAgentEntity>(
      "SELECT * FROM meta_task_agents WHERE task_id = ? AND agent_id = ?",
      taskId,
      agentId,
    ))!;
  }
  async unlinkTaskAgent(taskId: string, agentId: string): Promise<void> {
    await this.run(
      "DELETE FROM meta_task_agents WHERE task_id = ? AND agent_id = ?",
      taskId,
      agentId,
    );
  }
  async listTaskAgents(
    taskId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TaskAgentEntity>> {
    const base =
      "FROM meta_task_agents WHERE task_id = ? AND status = 'active'";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [taskId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [taskId],
      pagination,
      (r) => r as unknown as TaskAgentEntity,
    );
  }
  // ============================================================
  // ParticipationLog
  // ============================================================
  async appendParticipationLog(
    input: AppendParticipationLogInput,
  ): Promise<ParticipationLogEntity> {
    const now = nowIso();
    const createdAt = input.created_at ?? now;
    const entity: ParticipationLogEntity = {
      id: generateRelationId(),
      team_id: input.team_id,
      task_id: input.task_id,
      agent_id: input.agent_id,
      user_id: input.user_id,
      source: input.source ?? "unknown",
      metadata_json: input.metadata_json ?? "{}",
      created_at: createdAt,
      updated_at: createdAt,
    };
    await this.run(
      `INSERT INTO meta_participation_logs
        (id, team_id, task_id, agent_id, user_id, source, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entity.id,
      entity.team_id,
      entity.task_id,
      entity.agent_id,
      entity.user_id,
      entity.source,
      entity.metadata_json,
      entity.created_at,
      entity.updated_at,
    );
    return entity;
  }
  async listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<ParticipationLogEntity>> {
    const { sql, params } = this.buildParticipationLogWhere(filter);
    if (filter.dedupe) {
      const dedupeIds = `
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
          FROM meta_participation_logs
          WHERE ${sql}
        ) WHERE rn = 1
      `;
      return await this.selectList(
        `SELECT COUNT(*) AS c FROM (${dedupeIds})`,
        params,
        `SELECT * FROM meta_participation_logs WHERE id IN (${dedupeIds}) ORDER BY created_at DESC, id DESC`,
        params,
        pagination,
        (r) => this.mapParticipationLog(r),
      );
    }
    const base = `FROM meta_participation_logs WHERE ${sql}`;
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      params,
      `SELECT * ${base} ORDER BY created_at DESC, id DESC`,
      params,
      pagination,
      (r) => this.mapParticipationLog(r),
    );
  }
  private buildParticipationLogWhere(filter: ParticipationLogFilter): {
    sql: string;
    params: SQLInputValue[];
  } {
    const conditions = ["team_id = ?"];
    const params: SQLInputValue[] = [filter.team_id];
    if (filter.task_id) {
      conditions.push("task_id = ?");
      params.push(filter.task_id);
    }
    if (filter.agent_id) {
      conditions.push("agent_id = ?");
      params.push(filter.agent_id);
    }
    if (filter.user_id) {
      conditions.push("user_id = ?");
      params.push(filter.user_id);
    }
    if (filter.created_after) {
      conditions.push("created_at >= ?");
      params.push(filter.created_after);
    }
    if (filter.created_before) {
      conditions.push("created_at <= ?");
      params.push(filter.created_before);
    }
    return { sql: conditions.join(" AND "), params };
  }
  private mapParticipationLog(row: Row | null): ParticipationLogEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      team_id: String(r.team_id),
      task_id: String(r.task_id),
      agent_id: String(r.agent_id),
      user_id: String(r.user_id),
      source: String(r.source),
      metadata_json: String(r.metadata_json),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
  // ============================================================
  // Asset
  // ============================================================
  async createAsset(input: CreateAssetInput): Promise<AssetEntity> {
    const now = nowIso();
    const assetId = input.asset_id;
    await this.run(
      `INSERT INTO meta_assets
        (asset_id, team_id, asset_type, name, description, owner_user_id, source_type, source_ref,
         version, visibility, status, confidence, expires_at, last_used_at, usage_count, content_ref,
         created_at, updated_at, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      assetId,
      input.team_id,
      input.asset_type,
      input.name,
      input.description ?? null,
      input.owner_user_id,
      input.source_type,
      input.source_ref ?? null,
      1,
      input.visibility ?? "team",
      input.status ?? "draft",
      input.confidence ?? null,
      input.expires_at ?? null,
      null,
      0,
      input.content_ref ?? null,
      now,
      now,
      input.metadata_json ?? "{}",
    );
    return (await this.getAssetById(assetId))!;
  }
  async getAssetById(assetId: string): Promise<AssetEntity | null> {
    return this.mapAsset(
      await this.get("SELECT * FROM meta_assets WHERE asset_id = ?", assetId),
    );
  }
  async updateAsset(
    assetId: string,
    patch: Partial<AssetEntity>,
  ): Promise<AssetEntity | null> {
    const allowed = [
      "name",
      "description",
      "visibility",
      "status",
      "confidence",
      "expires_at",
      "content_ref",
      "version",
      "source_ref",
      "metadata_json",
    ] as const;
    await this.applyUpdate("meta_assets", "asset_id", assetId, allowed, patch);
    return await this.getAssetById(assetId);
  }
  async deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> {
    // 物理删除 meta_assets，并级联清理绑定与 ACL。
    // 已不存在视为幂等成功（Skill 钩子/handler 双通道会二次调用）。
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of assetIds) {
      const existing = await this.getAssetById(id);
      if (!existing) {
        result.deleted_ids.push(id);
        continue;
      }
      await this.tx(async () => {
        await this.run(
          "DELETE FROM meta_agent_fixed_assets WHERE asset_id = ?",
          id,
        );
        await this.run("DELETE FROM meta_asset_acl WHERE asset_id = ?", id);
        await this.run("DELETE FROM meta_assets WHERE asset_id = ?", id);
      });
      result.deleted_ids.push(id);
    }
    return result;
  }
  async listAssetsByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: AssetFilter,
  ): Promise<ListPage<AssetEntity>> {
    let where = "WHERE team_id = ?";
    const params: SQLInputValue[] = [teamId];
    if (filter?.asset_type) {
      where += " AND asset_type = ?";
      params.push(filter.asset_type);
    }
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.owner_user_id) {
      where += " AND owner_user_id = ?";
      params.push(filter.owner_user_id);
    }
    if (filter?.visibility) {
      where += " AND visibility = ?";
      params.push(filter.visibility);
    }
    return await this.selectList(
      `SELECT COUNT(*) AS c FROM meta_assets ${where}`,
      params,
      `SELECT * FROM meta_assets ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapAsset(r),
    );
  }
  async touchAssetUsage(assetId: string): Promise<void> {
    await this.run(
      "UPDATE meta_assets SET usage_count = usage_count + 1, last_used_at = ? WHERE asset_id = ?",
      nowIso(),
      assetId,
    );
  }
  // ============================================================
  // AgentFixedAsset（全量替换）
  // ============================================================
  async setAgentFixedAssets(
    agentId: string,
    bindings: FixedAssetBindingInput[],
  ): Promise<void> {
    const now = nowIso();
    for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
      try {
        await this.tx(async () => {
          await this.run(
            "DELETE FROM meta_agent_fixed_assets WHERE agent_id = ?",
            agentId,
          );
          for (const b of bindings) {
            await this.run(
              `INSERT INTO meta_agent_fixed_assets
            (id, agent_id, asset_id, asset_type, injection_mode, priority, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
              generateRelationId(),
              agentId,
              b.asset_id,
              b.asset_type,
              b.injection_mode ?? "summary",
              b.priority ?? 50,
              b.created_by,
              now,
            );
          }
        });
        return;
      } catch (err) {
        if (isPostgresRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("relation id collision after max retries");
  }
  async addAgentFixedAsset(
    agentId: string,
    b: FixedAssetBindingInput,
  ): Promise<void> {
    // UNIQUE(agent_id, asset_id) 已在 schema 里定义（sqlite-adapter.ts:227 段），
    // INSERT OR IGNORE 命中冲突时 no-op，天然幂等。
    await this.run(
      `INSERT INTO meta_agent_fixed_assets
        (id, agent_id, asset_id, asset_type, injection_mode, priority, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      generateRelationId(),
      agentId,
      b.asset_id,
      b.asset_type,
      b.injection_mode ?? "summary",
      b.priority ?? 50,
      b.created_by,
      nowIso(),
    );
  }
  async listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    filter?: {
      assetTypes?: readonly string[];
    },
  ): Promise<ListPage<FixedAssetBindingEntity>> {
    const types = filter?.assetTypes ?? [];
    if (types.length > 0) {
      // JOIN meta_assets 做类型过滤，避免"分页在前、类型过滤在后"截断
      const placeholders = types.map(() => "?").join(",");
      const base = `FROM meta_agent_fixed_assets b
        INNER JOIN meta_assets a ON a.asset_id = b.asset_id
        WHERE b.agent_id = ? AND a.asset_type IN (${placeholders})`;
      const params: SQLInputValue[] = [agentId, ...types];
      return await this.selectList(
        `SELECT COUNT(*) AS c ${base}`,
        params,
        `SELECT b.* ${base} ORDER BY b.priority DESC, b.created_at DESC`,
        params,
        pagination,
        (r) => r as unknown as FixedAssetBindingEntity,
      );
    }
    const base = "FROM meta_agent_fixed_assets WHERE agent_id = ?";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [agentId],
      `SELECT * ${base} ORDER BY priority DESC, created_at DESC`,
      [agentId],
      pagination,
      (r) => r as unknown as FixedAssetBindingEntity,
    );
  }
  async getAgentFixedAsset(
    agentId: string,
    assetId: string,
  ): Promise<FixedAssetBindingEntity | null> {
    return await this.get<FixedAssetBindingEntity>(
      "SELECT * FROM meta_agent_fixed_assets WHERE agent_id = ? AND asset_id = ?",
      agentId,
      assetId,
    );
  }
  async summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: {
      assetId?: string;
    },
  ): Promise<AgentFixedAssetCountRow[]> {
    if (agentIds.length === 0) return [];
    const ph = agentIds.map(() => "?").join(",");
    const params: SQLInputValue[] = [...agentIds];
    let sql = `SELECT agent_id, asset_type, COUNT(DISTINCT asset_id) AS cnt
       FROM meta_agent_fixed_assets
       WHERE agent_id IN (${ph})`;
    if (options?.assetId) {
      sql += ` AND asset_id = ?`;
      params.push(options.assetId);
    }
    sql += ` GROUP BY agent_id, asset_type`;
    const rows = await this.all<{
      agent_id: string;
      asset_type: string;
      cnt: number | bigint;
    }>(sql, ...params);
    return rows.map((r) => ({
      agent_id: r.agent_id,
      asset_type: r.asset_type as AssetType,
      cnt: Number(r.cnt),
    }));
  }
  // ============================================================
  // ACL
  // ============================================================
  async grantAcl(input: GrantAclInput): Promise<AclEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(
      input.id,
      isPostgresRelationIdCollision,
      async (id) => {
        await this.run(
          `INSERT INTO meta_asset_acl
        (id, asset_id, subject_type, subject_id, permission, effect, granted_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(asset_id, subject_type, subject_id, permission)
       DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
          id,
          input.asset_id,
          input.subject_type,
          input.subject_id,
          input.permission,
          input.effect ?? "allow",
          input.granted_by,
          now,
          now,
        );
      },
    );
    return (await this.get<AclEntity>(
      "SELECT * FROM meta_asset_acl WHERE asset_id = ? AND subject_type = ? AND subject_id = ? AND permission = ?",
      input.asset_id,
      input.subject_type,
      input.subject_id,
      input.permission,
    ))!;
  }
  async getAclById(id: string): Promise<AclEntity | null> {
    return await this.get<AclEntity>(
      "SELECT * FROM meta_asset_acl WHERE id = ?",
      id,
    );
  }
  async revokeAcl(id: string): Promise<void> {
    await this.run("DELETE FROM meta_asset_acl WHERE id = ?", id);
  }
  async listAclByAsset(
    assetId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<AclEntity>> {
    const base = "FROM meta_asset_acl WHERE asset_id = ?";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [assetId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [assetId],
      pagination,
      (r) => r as unknown as AclEntity,
    );
  }
  async listAclBySubject(
    subjectType: string,
    subjectId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<AclEntity>> {
    const base =
      "FROM meta_asset_acl WHERE subject_type = ? AND subject_id = ?";
    return await this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [subjectType, subjectId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [subjectType, subjectId],
      pagination,
      (r) => r as unknown as AclEntity,
    );
  }
  // ============================================================
  // Helpers
  // ============================================================
  private async applyUpdate<T>(
    table: string,
    pkCol: string,
    pkVal: string,
    allowed: readonly string[],
    patch: Partial<T>,
  ): Promise<void> {
    const fields: Record<string, SQLInputValue> = {};
    for (const k of allowed) {
      const v = (patch as Record<string, unknown>)[k];
      if (k in (patch as object) && v !== undefined) {
        fields[k] = v as SQLInputValue;
      }
    }
    await this.applyUpdateRaw(table, pkCol, pkVal, fields);
  }
  private async applyUpdateRaw(
    table: string,
    pkCol: string,
    pkVal: string,
    fields: Record<string, SQLInputValue>,
  ): Promise<void> {
    const keys = Object.keys(fields);
    const hasUpdatedAt = [
      "meta_users",
      "meta_teams",
      "meta_agents",
      "meta_tasks",
      "meta_assets",
    ].includes(table);
    if (keys.length === 0 && !hasUpdatedAt) return;
    const sets = keys.map((k) => `${k} = ?`);
    const params: SQLInputValue[] = keys.map((k) => fields[k]);
    if (hasUpdatedAt) {
      sets.push("updated_at = ?");
      params.push(nowIso());
    }
    if (sets.length === 0) return;
    params.push(pkVal);
    await this.run(
      `UPDATE ${table} SET ${sets.join(", ")} WHERE ${pkCol} = ?`,
      ...params,
    );
  }
  private async batchDelete(
    table: string,
    pkCol: string,
    ids: string[],
  ): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of ids) {
      const exists = await this.get(
        `SELECT ${pkCol} FROM ${table} WHERE ${pkCol} = ?`,
        id,
      );
      if (!exists) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      await this.run(`DELETE FROM ${table} WHERE ${pkCol} = ?`, id);
      result.deleted_ids.push(id);
    }
    return result;
  }
  // ── Row mappers ──
  private mapUser(row: Row | null): UserEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      user_id: String(r.user_id),
      password: r.password != null ? String(r.password) : null,
      auth_provider: String(r.auth_provider),
      external_id: String(r.external_id),
      username: String(r.username),
      display_name: r.display_name != null ? String(r.display_name) : null,
      email: r.email != null ? String(r.email) : null,
      raw_profile_json: String(r.raw_profile_json ?? "{}"),
      status: String(r.status) as UserEntity["status"],
      user_type: String(r.user_type ?? "normal") as UserEntity["user_type"],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }
  private mapTeam(row: Row | null): TeamEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      team_id: String(r.team_id),
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      owner_user_id: String(r.owner_user_id),
      status: String(r.status) as TeamEntity["status"],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }
  private mapAgent(row: Row | null): AgentEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      agent_id: String(r.agent_id),
      team_id: String(r.team_id),
      owner_user_id: String(r.owner_user_id),
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      prompt: r.prompt != null ? String(r.prompt) : null,
      visibility: String(r.visibility ?? "team") as AgentEntity["visibility"],
      status: String(r.status) as AgentEntity["status"],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }
  private mapTask(row: Row | null): TaskEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      task_id: String(r.task_id),
      team_id: String(r.team_id),
      creator_user_id: String(r.creator_user_id),
      title: String(r.title),
      description: r.description != null ? String(r.description) : null,
      source_type: String(r.source_type) as TaskEntity["source_type"],
      source_url: r.source_url != null ? String(r.source_url) : null,
      status: String(r.status) as TaskEntity["status"],
      auto_assign_floating_assets: Boolean(r.auto_assign_floating_assets),
      risk_level: r.risk_level != null ? String(r.risk_level) : null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }
  private mapAsset(row: Row | null): AssetEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      asset_id: String(r.asset_id),
      team_id: String(r.team_id),
      asset_type: String(r.asset_type) as AssetEntity["asset_type"],
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      owner_user_id: String(r.owner_user_id),
      source_type: String(r.source_type),
      source_ref: r.source_ref != null ? String(r.source_ref) : null,
      version: Number(r.version ?? 1),
      visibility: String(r.visibility) as AssetEntity["visibility"],
      status: String(r.status) as AssetEntity["status"],
      confidence: r.confidence != null ? Number(r.confidence) : null,
      expires_at: r.expires_at != null ? String(r.expires_at) : null,
      last_used_at: r.last_used_at != null ? String(r.last_used_at) : null,
      usage_count: Number(r.usage_count ?? 0),
      content_ref: r.content_ref != null ? String(r.content_ref) : null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }
  // ============================================================
  // ConfigParam
  // ============================================================
  async getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): Promise<ConfigParamEntity | null> {
    let row: Row | null;
    if (scope === "global") {
      row = await this.get<Row>(
        `SELECT * FROM meta_config_params WHERE scope = 'global' AND module = ? AND param_name = ?`,
        module,
        paramName,
      );
    } else {
      row = await this.get<Row>(
        `SELECT * FROM meta_config_params WHERE scope = 'user' AND user_id = ? AND module = ? AND param_name = ?`,
        userId!,
        module,
        paramName,
      );
    }
    return this.mapConfigParam(row);
  }
  async upsertConfigParam(
    input: UpsertConfigParamInput,
  ): Promise<ConfigParamEntity> {
    return await this.tx(async () => {
      const now = nowIso();
      if (input.scope === "global") {
        try {
          const existing = await this.get<Row>(
            `SELECT id FROM meta_config_params WHERE scope = 'global' AND module = ? AND param_name = ?`,
            input.module,
            input.param_name,
          );
          if (existing) {
            await this.run(
              `UPDATE meta_config_params SET param_value = ?, description = ?, updated_at = ? WHERE id = ?`,
              input.param_value,
              input.description,
              now,
              (existing as any).id,
            );
          } else {
            await this.run(
              `INSERT INTO meta_config_params (scope, user_id, module, param_name, param_value, description, created_at, updated_at)
             VALUES ('global', NULL, ?, ?, ?, ?, ?, ?)`,
              input.module,
              input.param_name,
              input.param_value,
              input.description,
              now,
              now,
            );
          }
        } catch (err) {
          throw err;
        }
      } else {
        try {
          const existing = await this.get<Row>(
            `SELECT id FROM meta_config_params WHERE scope = 'user' AND user_id = ? AND module = ? AND param_name = ?`,
            input.user_id!,
            input.module,
            input.param_name,
          );
          if (existing) {
            await this.run(
              `UPDATE meta_config_params SET param_value = ?, description = ?, updated_at = ? WHERE id = ?`,
              input.param_value,
              input.description,
              now,
              (existing as any).id,
            );
          } else {
            await this.run(
              `INSERT INTO meta_config_params (scope, user_id, module, param_name, param_value, description, created_at, updated_at)
             VALUES ('user', ?, ?, ?, ?, ?, ?, ?)`,
              input.user_id!,
              input.module,
              input.param_name,
              input.param_value,
              input.description,
              now,
              now,
            );
          }
        } catch (err) {
          throw err;
        }
      }
      const result = await this.getConfigParam(
        input.scope,
        input.scope === "user" ? input.user_id! : null,
        input.module,
        input.param_name,
      );
      return result!;
    });
  }
  async listConfigParams(
    filter: ListConfigParamsFilter,
  ): Promise<ConfigParamEntity[]> {
    const conditions: string[] = [`module = ?`];
    const params: SQLInputValue[] = [filter.module];
    if (filter.scope) {
      conditions.push(`scope = ?`);
      params.push(filter.scope);
    }
    if (filter.userId) {
      conditions.push(`(scope = 'global' OR (scope = 'user' AND user_id = ?))`);
      params.push(filter.userId);
    }
    if (filter.paramNames && filter.paramNames.length > 0) {
      const placeholders = filter.paramNames.map(() => "?").join(", ");
      conditions.push(`param_name IN (${placeholders})`);
      params.push(...filter.paramNames);
    }
    const sql = `SELECT * FROM meta_config_params WHERE ${conditions.join(" AND ")} ORDER BY scope ASC, param_name ASC`;
    const rows = await this.all<Row>(sql, ...params);
    return rows.map((r) => this.mapConfigParam(r)!);
  }
  private mapConfigParam(row: Row | null): ConfigParamEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      id: Number(r.id),
      scope: String(r.scope) as ConfigParamEntity["scope"],
      user_id: r.user_id != null ? String(r.user_id) : null,
      module: String(r.module),
      param_name: String(r.param_name),
      param_value: String(r.param_value),
      description: String(r.description),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
  // ============================================================
  // UserSessionDefault (v3.3) — 用户级 (team, agent, task) 默认三元组
  // ============================================================
  async getUserSessionDefault(
    userId: string,
  ): Promise<UserSessionDefaultEntity | null> {
    return this.mapUserSessionDefault(
      await this.get<Row>(
        "SELECT * FROM meta_user_session_defaults WHERE user_id = ?",
        userId,
      ),
    );
  }
  async upsertUserSessionDefault(
    input: UpsertUserSessionDefaultInput,
  ): Promise<UserSessionDefaultEntity> {
    return await this.tx(async () => {
      const now = nowIso();
      // upsert 事务:若已存在,保留原 created_at,仅刷新 updated_at + 其他字段。
      try {
        const existing = await this.get<Row>(
          "SELECT created_at FROM meta_user_session_defaults WHERE user_id = ?",
          input.user_id,
        );
        if (existing) {
          await this.run(
            `UPDATE meta_user_session_defaults
             SET team_id = ?, agent_id = ?, task_id = ?, updated_at = ?
           WHERE user_id = ?`,
            input.team_id,
            input.agent_id,
            input.task_id,
            now,
            input.user_id,
          );
        } else {
          await this.run(
            `INSERT INTO meta_user_session_defaults
             (user_id, team_id, agent_id, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
            input.user_id,
            input.team_id,
            input.agent_id,
            input.task_id,
            now,
            now,
          );
        }
      } catch (err) {
        throw err;
      }
      const row = await this.getUserSessionDefault(input.user_id);
      if (!row) {
        throw new Error(
          "upsertUserSessionDefault: row disappeared after write",
        );
      }
      return row;
    });
  }
  async deleteUserSessionDefault(userId: string): Promise<number> {
    return (
      (
        await this.db.query(
          "DELETE FROM meta_user_session_defaults WHERE user_id = $1",
          [userId],
        )
      ).rowCount ?? 0
    );
  }
  private mapUserSessionDefault(
    row: Row | null,
  ): UserSessionDefaultEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      user_id: String(r.user_id),
      team_id: String(r.team_id),
      agent_id: String(r.agent_id),
      task_id: String(r.task_id),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
  // ── InstanceUpstreamConfig (v2 模型组) ─────────────────────────────────
  //
  // 所有写入方法都用 withImmediateTx 包裹,拿 RESERVED lock 后:
  //   1. SELECT-all → 内存构建 "其他行 agents 并集" (排除自身 group_id)
  //   2. 校验:agents 全域唯一 / group_type mismatch / version match
  //   3. UPSERT/UPDATE/DELETE 完成后再 COMMIT
  // 并发写入的第二个 IMMEDIATE 阻塞等待 busy_timeout(5s),自动串行化。
  async getInstanceUpstreamGroup(
    groupId: string,
  ): Promise<InstanceUpstreamConfigEntity | null> {
    return this.mapInstanceUpstreamGroup(
      await this.get(
        "SELECT * FROM meta_instance_upstream_config WHERE group_id = ?",
        groupId,
      ),
    );
  }
  async listInstanceUpstreamGroups(
    filter?: InstanceUpstreamConfigFilter,
    seedIfEmpty?: SupportedAgent[],
  ): Promise<InstanceUpstreamConfigEntity[]> {
    // seed + diff-append 只在传入 supportedAgents 时跑。
    // seed 分支已抽成 ensureDefaultSeeded,供其他写入路径共用(存量实例首个请求
    // 不是 list 而是 create/update/toggle/... 时的兜底,防止 default 未 seed 导致
    // AGENT_NOT_CONFIGURED)。
    if (seedIfEmpty && seedIfEmpty.length > 0) {
      await this.ensureDefaultSeeded(seedIfEmpty);
      // 已存在 default → 走 diff-append 同步逻辑(方案 E)
      await this._syncDefaultAgentsWithSnapshot(seedIfEmpty);
    }
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter?.group_type) {
      conditions.push("group_type = ?");
      params.push(filter.group_type);
    }
    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    // 排序:group_type default → custom → extraction, 同类 updated_at DESC
    const sql = `SELECT * FROM meta_instance_upstream_config${where}
      ORDER BY CASE group_type WHEN 'default' THEN 0 WHEN 'custom' THEN 1 ELSE 2 END,
      updated_at DESC`;
    const rows = await this.all(sql, ...params);
    return rows.map((r) => this.mapInstanceUpstreamGroup(r)!);
  }
  /**
   * 幂等 seed:若 default 行不存在,写入一行 (agents=supported, mode=official)。
   * 供 list 及所有写入路径(create/update/toggle/delete + extraction/*)共用。
   *
   * 与 diff-append 分离:seed 只保证 "有" default 一行,不做 supported ↔ snapshot
   * 收敛;后者只在 listInstanceUpstreamGroups 里跑,避免所有写入都刷 snapshot。
   */
  async ensureDefaultSeeded(supported: SupportedAgent[]): Promise<void> {
    if (!supported || supported.length === 0) return;
    const hasDefault = await this.get(
      "SELECT id FROM meta_instance_upstream_config WHERE group_type='default' LIMIT 1",
    );
    if (hasDefault) return;
    try {
      await this.withImmediateTx(async () => {
        // 事务内再确认一次(可能刚被别人 seed)
        const check = await this.get(
          "SELECT id FROM meta_instance_upstream_config WHERE group_type='default' LIMIT 1",
        );
        if (check) return;
        const now = nowIso();
        const agentsList = Array.from(
          new Set(supported.map((a) => a.agent_source)),
        ).sort();
        await this.run(
          `INSERT INTO meta_instance_upstream_config
            (group_id, group_type, name, agents, enabled, mode, base_url, api_key, model_id, description, version, supported_agents_snapshot, created_at, updated_at)
           VALUES (?, 'default', ?, ?, 1, 'official', '', '', '', '', 1, ?, ?, ?)`,
          this.newGroupId("default"),
          DEFAULT_GROUP_NAME,
          JSON.stringify(agentsList),
          JSON.stringify(agentsList), // seed 时 snapshot = agents
          now,
          now,
        );
      });
    } catch (e) {
      // 并发下的 UNIQUE 冲突:另一个进程刚 seed 完 → 忽略
      const msg = (e as Error).message ?? "";
      if (!msg.includes("UNIQUE") && !msg.includes("unique")) throw e;
    }
  }
  /**
   * 方案 E:default.agents 与 supported-agents 全集 diff-append 同步。
   *
   * 场景对照(design doc §11 决策 11d):
   * - A. seed 首次: 由 seed 分支直接写入,不走本方法
   * - B. 存量实例 snapshot=空: 视为"用户已认可当前状态",snapshot 填成 agents,不改 agents
   * - C. Proxy 加了新 agent(supported > snapshot): diff append 到 agents,snapshot 更新
   * - D. 用户主动 remove agent + Proxy 又加了新的: 只加新的,不恢复用户 remove 的
   * - E. Proxy 下线 agent(supported < snapshot): snapshot 收缩,agents 不动
   *      (老 agent 在 agents 里但已从 supported 移除是合法的,请求会 unmanaged;由 Panel 引导清理)
   * - F. 无变化(diff=空): 不写 db,hot path 零开销
   *
   * 并发保护:UPDATE 用 WHERE version=<读到的>,失败静默(另一次 list 会重试);
   * SQLite BEGIN IMMEDIATE 也是串行锁,极难冲突。
   */
  private async _syncDefaultAgentsWithSnapshot(
    supported: SupportedAgent[],
  ): Promise<void> {
    const supportedNames = Array.from(
      new Set(supported.map((a) => a.agent_source)),
    ).sort();
    const supportedSet = new Set(supportedNames);
    const row = await this.get(
      "SELECT id, group_id, agents, supported_agents_snapshot, version FROM meta_instance_upstream_config WHERE group_type='default' LIMIT 1",
    );
    if (!row) return; // 表还没 seed(理论上不该发生,seed 分支应先跑)
    const r = row as Record<string, unknown>;
    let currentAgents: string[] = [];
    let currentSnapshot: string[] = [];
    try {
      currentAgents = JSON.parse(String(r.agents ?? "[]"));
    } catch {
      /* 保持空 */
    }
    try {
      currentSnapshot = JSON.parse(String(r.supported_agents_snapshot ?? "[]"));
    } catch {
      /* 保持空 */
    }
    const version = Number(r.version ?? 1);
    // 场景 B: snapshot 空(存量实例首次)→ 只补 snapshot,不改 agents
    if (currentSnapshot.length === 0) {
      const now = nowIso();
      await this.run(
        `UPDATE meta_instance_upstream_config
         SET supported_agents_snapshot = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        JSON.stringify(supportedNames),
        now,
        Number(r.id),
        version,
      );
      return;
    }
    // 场景 C/D: supported 里有 snapshot 之外的新 agent → append 到 agents + snapshot 更新
    const newAgents = supportedNames.filter(
      (a) => !currentSnapshot.includes(a),
    );
    // 场景 E: supported 收缩(agent 下线),snapshot 也跟着收缩,但 agents 不动
    const snapshotShrunk = currentSnapshot.some((a) => !supportedSet.has(a));
    if (newAgents.length === 0 && !snapshotShrunk) {
      return; // hot path: 全无变化,零开销
    }
    // 计算新 agents:union(current, newAgents),但要保持 全域唯一(不能跟 custom 组的 agents 重叠)
    const nextAgents = [...currentAgents];
    if (newAgents.length > 0) {
      // 检查这些新 agent 有没有被 custom 组占用
      const customRows = await this.all<Row>(
        "SELECT agents FROM meta_instance_upstream_config WHERE group_type='custom'",
      );
      const customUsed = new Set<string>();
      for (const cr of customRows) {
        try {
          for (const a of JSON.parse(
            String((cr as Record<string, unknown>).agents ?? "[]"),
          ))
            customUsed.add(a);
        } catch {
          /* skip */
        }
      }
      for (const a of newAgents) {
        if (!customUsed.has(a) && !nextAgents.includes(a)) nextAgents.push(a);
      }
    }
    const nextSnapshot = supportedNames; // 收缩 + 扩张都对齐 supported
    const now = nowIso();
    await this.run(
      `UPDATE meta_instance_upstream_config
       SET agents = ?, supported_agents_snapshot = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
      JSON.stringify(nextAgents),
      JSON.stringify(nextSnapshot),
      now,
      Number(r.id),
      version,
    );
  }
  async createInstanceUpstreamGroup(
    input: CreateInstanceUpstreamGroupInput,
  ): Promise<InstanceUpstreamConfigEntity> {
    const groupId = this.newGroupId(input.group_type);
    const now = nowIso();
    const agents = input.agents ?? [];
    return await this.withImmediateTx(async () => {
      // 1. 单例约束(default / extraction 只能一行)
      if (input.group_type === "default" || input.group_type === "extraction") {
        const existing = await this.get(
          "SELECT group_id FROM meta_instance_upstream_config WHERE group_type = ? LIMIT 1",
          input.group_type,
        );
        if (existing) {
          throw new InstanceUpstreamWriteConflictError(
            input.group_type === "default"
              ? "default_already_exists"
              : "extraction_already_exists",
            `${input.group_type} group already exists in this instance`,
          );
        }
      }
      // 2. agents 全域唯一校验(仅 default/custom 参与)
      if (input.group_type !== "extraction") {
        await this.assertAgentsNotOverlap(agents, null);
      }
      // 2b. 组名全域唯一(仅 custom 参与写入方,校验目标含 default/extraction 保留名)
      //     default/extraction 走 seed 的固定名不触发此路径。历史脏数据不清理,
      //     只拦新写入 —— 参考设计文档 §5.3(v2.8)。
      if (input.group_type === "custom") {
        await this.assertGroupNameUnique(input.name ?? "", null);
      }
      // 3. INSERT(custom/extraction 的 snapshot 恒 [];default 由 seed 路径独立处理,不走此 create 分支)
      await this.run(
        `INSERT INTO meta_instance_upstream_config
          (group_id, group_type, name, agents, enabled, mode, base_url, api_key, model_id, description, version, supported_agents_snapshot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', ?, ?)`,
        groupId,
        input.group_type,
        input.name ?? "",
        JSON.stringify(agents),
        input.enabled === false ? 0 : 1,
        input.mode,
        input.base_url ?? "",
        input.api_key ?? "",
        input.model_id ?? "",
        input.description ?? "",
        now,
        now,
      );
      return (await this.getInstanceUpstreamGroup(groupId))!;
    });
  }
  async updateInstanceUpstreamGroup(
    input: UpdateInstanceUpstreamGroupInput,
  ): Promise<InstanceUpstreamConfigEntity> {
    return await this.withImmediateTx(async () => {
      const row = await this.get(
        "SELECT * FROM meta_instance_upstream_config WHERE group_id = ?",
        input.group_id,
      );
      if (!row) {
        throw new InstanceUpstreamWriteConflictError(
          "group_not_found",
          `group not found: ${input.group_id}`,
        );
      }
      const current = this.mapInstanceUpstreamGroup(row)!;
      if (current.group_type !== input.expected_group_type) {
        throw new InstanceUpstreamWriteConflictError(
          "group_type_mismatch",
          `expected ${input.expected_group_type}, actual ${current.group_type}`,
          { expected: input.expected_group_type, actual: current.group_type },
        );
      }
      if (
        input.expected_version !== undefined &&
        input.expected_version !== current.version
      ) {
        throw new InstanceUpstreamWriteConflictError(
          "version_mismatch",
          `version mismatch: expected ${input.expected_version}, actual ${current.version}`,
          { expected: input.expected_version, actual: current.version },
        );
      }
      // agents 变更 → 校验全域唯一(排除自身)
      const nextAgents = input.agents ?? current.agents;
      if (input.agents !== undefined && current.group_type !== "extraction") {
        await this.assertAgentsNotOverlap(nextAgents, current.group_id);
      }
      // name 变更 → 校验全域唯一(仅 custom;default/extraction 的 name 由 service 层
      // DEFAULT_GROUP_IMMUTABLE_FIELDS 拦掉,这里再兜一次)
      //
      // 历史脏数据豁免:如果 trim 后 name 与 current.name 完全相同(前端"编辑弹层"
      // 回传原名的常见姿势),不触发查重 — 否则库里已有的重名行任何 update 都会挂,
      // 违背"以前重名的就算了不管"的产品约定。参考设计文档 §5.3(v2.8)。
      if (
        input.name !== undefined &&
        current.group_type === "custom" &&
        (input.name ?? "").trim() !== (current.name ?? "").trim()
      ) {
        await this.assertGroupNameUnique(input.name, current.group_id);
      }
      // PATCH 合并
      const merged = {
        name: input.name ?? current.name,
        agents: nextAgents,
        enabled: input.enabled ?? current.enabled,
        mode: input.mode ?? current.mode,
        base_url: input.base_url ?? current.base_url,
        api_key: input.api_key ?? current.api_key,
        model_id: input.model_id ?? current.model_id,
        description: input.description ?? current.description,
      };
      const now = nowIso();
      await this.run(
        `UPDATE meta_instance_upstream_config
         SET name = ?, agents = ?, enabled = ?, mode = ?, base_url = ?, api_key = ?, model_id = ?, description = ?, version = version + 1, updated_at = ?
         WHERE group_id = ?`,
        merged.name,
        JSON.stringify(merged.agents),
        merged.enabled ? 1 : 0,
        merged.mode,
        merged.base_url,
        merged.api_key,
        merged.model_id,
        merged.description,
        now,
        input.group_id,
      );
      return (await this.getInstanceUpstreamGroup(input.group_id))!;
    });
  }
  async toggleInstanceUpstreamGroup(
    input: ToggleInstanceUpstreamGroupInput,
  ): Promise<InstanceUpstreamConfigEntity> {
    return await this.withImmediateTx(async () => {
      const row = await this.get(
        "SELECT * FROM meta_instance_upstream_config WHERE group_id = ?",
        input.group_id,
      );
      if (!row) {
        throw new InstanceUpstreamWriteConflictError(
          "group_not_found",
          `group not found: ${input.group_id}`,
        );
      }
      const current = this.mapInstanceUpstreamGroup(row)!;
      if (
        input.expected_version !== undefined &&
        input.expected_version !== current.version
      ) {
        throw new InstanceUpstreamWriteConflictError(
          "version_mismatch",
          `version mismatch: expected ${input.expected_version}, actual ${current.version}`,
          { expected: input.expected_version, actual: current.version },
        );
      }
      const now = nowIso();
      await this.run(
        `UPDATE meta_instance_upstream_config
         SET enabled = ?, version = version + 1, updated_at = ?
         WHERE group_id = ?`,
        input.enabled ? 1 : 0,
        now,
        input.group_id,
      );
      return (await this.getInstanceUpstreamGroup(input.group_id))!;
    });
  }
  async deleteInstanceUpstreamGroup(
    input: DeleteInstanceUpstreamGroupInput,
  ): Promise<boolean> {
    const existing = await this.get(
      "SELECT id FROM meta_instance_upstream_config WHERE group_id = ?",
      input.group_id,
    );
    if (!existing) return false;
    await this.run(
      "DELETE FROM meta_instance_upstream_config WHERE group_id = ?",
      input.group_id,
    );
    return true;
  }
  /**
   * 校验待写入 agents 与其他行的 agents 不重叠。
   * `selfGroupId` 传入时排除自己(update 场景);create 时传 null。
   * 冲突 → InstanceUpstreamWriteConflictError("agents_overlap", detail.conflict_groups)。
   */
  private async assertAgentsNotOverlap(
    candidate: string[],
    selfGroupId: string | null,
  ): Promise<void> {
    if (candidate.length === 0) return;
    const candidateSet = new Set(candidate);
    const rows = await this
      .all<Row>(`SELECT group_id, group_type, name, agents FROM meta_instance_upstream_config
       WHERE group_type IN ('default','custom')`);
    const conflicts: Array<{
      group_id: string;
      group_type: string;
      name: string;
      overlapping_agents: string[];
    }> = [];
    for (const r of rows) {
      const gid = String(r.group_id);
      if (gid === selfGroupId) continue;
      let existing: string[];
      try {
        existing = JSON.parse(String(r.agents));
      } catch {
        existing = [];
      }
      const overlap = existing.filter((a) => candidateSet.has(a));
      if (overlap.length > 0) {
        conflicts.push({
          group_id: gid,
          group_type: String(r.group_type),
          name: String(r.name),
          overlapping_agents: overlap,
        });
      }
    }
    if (conflicts.length > 0) {
      throw new InstanceUpstreamWriteConflictError(
        "agents_overlap",
        `agents overlap with ${conflicts.length} existing group(s)`,
        { conflict_groups: conflicts },
      );
    }
  }
  /**
   * 校验组名(trim 后)与其他任意组(含 default / extraction 保留名)不冲突。
   * 大小写敏感、空白 trim 后精确匹配。selfGroupId 传入时排除自己(update 场景);
   * create 时传 null。冲突 → InstanceUpstreamWriteConflictError("name_duplicate",
   * detail.conflict_group)。空串或全空白 name 直接放过(由 assertGroupName 兜住)。
   *
   * 历史脏数据不清理:表内已存在的重名行 list 出来照常,只在新写入时拦。
   * 参考设计文档 §5.3(v2.8)。
   */
  private async assertGroupNameUnique(
    candidateName: string,
    selfGroupId: string | null,
  ): Promise<void> {
    const candidate = (candidateName ?? "").trim();
    if (!candidate) return;
    const rows = await this.all<Row>(
      "SELECT group_id, group_type, name FROM meta_instance_upstream_config",
    );
    for (const r of rows) {
      const gid = String(r.group_id);
      if (gid === selfGroupId) continue;
      if (String(r.name ?? "").trim() === candidate) {
        throw new InstanceUpstreamWriteConflictError(
          "name_duplicate",
          `group name "${candidate}" is already used by another group in this instance`,
          {
            conflict_group: {
              group_id: gid,
              group_type: String(r.group_type),
              name: String(r.name ?? ""),
            },
          },
        );
      }
    }
  }
  /** 生成 group_id:default→dflt-<r> / custom→grp-<r> / extraction→ext-<r>。 */
  private newGroupId(gt: GroupType): string {
    const prefix =
      gt === "default" ? "dflt" : gt === "extraction" ? "ext" : "grp";
    return generateId(prefix);
  }
  private mapInstanceUpstreamGroup(
    row: Row | null,
  ): InstanceUpstreamConfigEntity | null {
    if (!row) return null;
    const r = row as Record<string, unknown>;
    let agents: string[] = [];
    try {
      agents = JSON.parse(String(r.agents ?? "[]"));
    } catch {
      agents = [];
    }
    let snapshot: string[] = [];
    try {
      snapshot = JSON.parse(String(r.supported_agents_snapshot ?? "[]"));
    } catch {
      snapshot = [];
    }
    return {
      id: Number(r.id),
      group_id: String(r.group_id),
      group_type: String(r.group_type) as GroupType,
      name: String(r.name ?? ""),
      agents,
      enabled: Number(r.enabled) === 1,
      mode: String(r.mode) as UpstreamMode,
      base_url: String(r.base_url ?? ""),
      api_key: String(r.api_key ?? ""),
      model_id: String(r.model_id ?? ""),
      description: String(r.description ?? ""),
      version: Number(r.version ?? 1),
      supported_agents_snapshot: snapshot,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
}
