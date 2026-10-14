/**
 * PostgresKnowledgeStore — PostgreSQL/Drizzle implementation of IKnowledgeStore.
 *
 * Responsibilities:
 *   - code-graph / wiki asset CRUD (hard delete; soft-delete markers via deleted_at)
 *   - Multi-tenant isolation (001, phase 5): EVERY read/write is scoped by
 *     `service_id` (first parameter), then `team_id` where applicable. id-only
 *     accessors also filter service_id so a foreign tenant can never read/mutate
 *     another tenant's row (returns null/false → 404).
 *   - Global ID generation (wiki-/cg-) + idempotency: same
 *     (service_id, team_id, repo_url, branch) or (service_id, team_id, name)
 *     duplicate create returns existing.
 *   - Status state machine + restart recovery.
 */

import { eq, and, isNull, desc, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  knowledgeCodeGraph,
  knowledgeWiki,
  knowledgeWikiAudit,
  knowledgeCodeGraphAudit,
  CODE_DATA_VERSION,
  WIKI_DATA_VERSION,
} from "../db/schema.js";
import { genCodeGraphId, genWikiId } from "./ids.js";
import type {
  IKnowledgeStore,
  SyncStatus,
  CodeGraphRow,
  CreateCodeGraphInput,
  CodeGraphStatusPatch,
  CodeGraphMetaPatch,
  WikiRow,
  CreateWikiInput,
  WikiStatusPatch,
  WikiMetaPatch,
  AuditLogInput,
  AuditLogRow,
  CreateResult,
  ListOpts,
  CountOpts,
  SyncedCodeGraphRef,
  SyncedWikiRef,
} from "./types.js";

const ID_RETRY = 5;

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /duplicate key|unique constraint/i.test(msg) ||
    (err as { cause?: { code?: string }; code?: string })?.code === "23505" ||
    (err as { cause?: { code?: string } })?.cause?.code === "23505"
  );
}

// ───────────────────────── Store ─────────────────────────

export class PostgresKnowledgeStore implements IKnowledgeStore {
  constructor(private readonly db: Db) {}

  // ═══════════════════════ Code-Graph ═══════════════════════

  /**
   * Idempotent create: hit (service_id, team_id, repo_url, branch) returns existing
   * (existed=true); otherwise generate cg- id and insert (PK conflict auto-retry).
   */
  async createCodeGraph(
    input: CreateCodeGraphInput,
  ): Promise<CreateResult<CodeGraphRow>> {
    const existing = (
      await this.db
        .select()
        .from(knowledgeCodeGraph)
        .where(
          and(
            eq(knowledgeCodeGraph.serviceId, input.service_id),
            eq(knowledgeCodeGraph.teamId, input.team_id),
            eq(knowledgeCodeGraph.repoUrl, input.repo_url),
            eq(knowledgeCodeGraph.branch, input.branch),
            isNull(knowledgeCodeGraph.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { row: this.mapCgRow(existing), existed: true };

    const ts = nowIso();
    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const id = genCodeGraphId();
      try {
        await this.db
          .insert(knowledgeCodeGraph)
          .values({
            codeGraphId: id,
            serviceId: input.service_id,
            teamId: input.team_id,
            repoName: input.repo_name ?? "",
            repoUrl: input.repo_url,
            branch: input.branch,
            ownerUserId: input.owner_user_id ?? null,
            userId: input.user_id ?? null,
            agentId: input.agent_id ?? null,
            taskId: input.task_id ?? null,
            visibility: input.visibility ?? "team",
            status: "pending",
            serviceUrl: input.service_url ?? null,
            version: CODE_DATA_VERSION,
            createdAt: ts,
            updatedAt: ts,
          })
          .execute();

        const row = (
          await this.db
            .select()
            .from(knowledgeCodeGraph)
            .where(eq(knowledgeCodeGraph.codeGraphId, id))
            .limit(1)
        )[0];
        return { row: this.mapCgRow(row!), existed: false };
      } catch (err) {
        // PK conflict → retry with new id; unique(memory,team,repo,branch) conflict → race, return existing
        const raced = (
          await this.db
            .select()
            .from(knowledgeCodeGraph)
            .where(
              and(
                eq(knowledgeCodeGraph.serviceId, input.service_id),
                eq(knowledgeCodeGraph.teamId, input.team_id),
                eq(knowledgeCodeGraph.repoUrl, input.repo_url),
                eq(knowledgeCodeGraph.branch, input.branch),
                isNull(knowledgeCodeGraph.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (raced) return { row: this.mapCgRow(raced), existed: true };
        if (!isUniqueViolation(err) || attempt === ID_RETRY - 1) throw err;
      }
    }
    throw new Error("createCodeGraph: failed to allocate unique id");
  }

  async getCodeGraph(
    serviceId: string,
    teamId: string,
    codeGraphId: string,
  ): Promise<CodeGraphRow | null> {
    const row = (
      await this.db
        .select()
        .from(knowledgeCodeGraph)
        .where(
          and(
            eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
            eq(knowledgeCodeGraph.serviceId, serviceId),
            eq(knowledgeCodeGraph.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    return row ? this.mapCgRow(row) : null;
  }

  /** id-only accessor — STILL scoped by service_id (cross-Memory leak guard, 001 §2.4). */
  async getCodeGraphById(
    serviceId: string,
    codeGraphId: string,
  ): Promise<CodeGraphRow | null> {
    const row = (
      await this.db
        .select()
        .from(knowledgeCodeGraph)
        .where(
          and(
            eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
            eq(knowledgeCodeGraph.serviceId, serviceId),
          ),
        )
        .limit(1)
    )[0];
    return row ? this.mapCgRow(row) : null;
  }

  async listCodeGraphs(
    serviceId: string,
    teamId: string,
    opts?: ListOpts,
  ): Promise<CodeGraphRow[]> {
    const conditions: SQL[] = [
      eq(knowledgeCodeGraph.serviceId, serviceId),
      eq(knowledgeCodeGraph.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeCodeGraph.status, opts.syncStatus));
    }
    const rows = await this.db
      .select()
      .from(knowledgeCodeGraph)
      .where(and(...conditions))
      .orderBy(desc(knowledgeCodeGraph.updatedAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0);
    return rows.map((r) => this.mapCgRow(r));
  }

  async countCodeGraphs(
    serviceId: string,
    teamId: string,
    opts?: CountOpts,
  ): Promise<number> {
    const conditions: SQL[] = [
      eq(knowledgeCodeGraph.serviceId, serviceId),
      eq(knowledgeCodeGraph.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeCodeGraph.status, opts.syncStatus));
    }
    const result = (
      await this.db
        .select({ total: sql<number>`count(*)` })
        .from(knowledgeCodeGraph)
        .where(and(...conditions))
        .limit(1)
    )[0];
    return Number(result?.total ?? 0);
  }

  /** id-only mutation — scoped by service_id so a foreign tenant cannot mutate. */
  async updateCodeGraphStatus(
    serviceId: string,
    codeGraphId: string,
    patch: CodeGraphStatusPatch,
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.internal_status !== undefined)
      set.internalStatus = patch.internal_status;
    if (patch.sync_error !== undefined) set.syncError = patch.sync_error;
    if (patch.commit_hash !== undefined) set.commitHash = patch.commit_hash;
    if (patch.stats_json !== undefined) set.statsJson = patch.stats_json;
    if (patch.last_sync_at !== undefined) set.lastSyncAt = patch.last_sync_at;
    if (patch.service_url !== undefined) set.serviceUrl = patch.service_url;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.version !== undefined) set.version = patch.version;

    await this.db
      .update(knowledgeCodeGraph)
      .set(set)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
        ),
      )
      .execute();
  }

  /** Hard delete; memory/team mismatch returns false. */
  async deleteCodeGraph(
    serviceId: string,
    teamId: string,
    codeGraphId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"knowledge/" + [serviceId, teamId, codeGraphId].join("/")}))`,
      );
      const result = await tx
        .delete(knowledgeCodeGraph)
        .where(
          and(
            eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
            eq(knowledgeCodeGraph.serviceId, serviceId),
            eq(knowledgeCodeGraph.teamId, teamId),
          ),
        )
        .execute();
      if (!(result.rowCount ?? 0)) return false;
      await tx.execute(
        sql`DELETE FROM knowledge_source_credential WHERE service_id=${serviceId} AND resource_type=${"code-graph"} AND resource_id=${codeGraphId}`,
      );
      await tx.execute(
        sql`DELETE FROM knowledge_artifact_scope WHERE namespace='knowledge' AND scope=${[serviceId, teamId, codeGraphId].join("/")}`,
      );
      return true;
    });
  }

  /** Update code-graph metadata (repo_name, summary). memory mismatch → null. */
  async updateCodeGraphMeta(
    serviceId: string,
    codeGraphId: string,
    patch: CodeGraphMetaPatch,
  ): Promise<CodeGraphRow | null> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.repo_name !== undefined) set.repoName = patch.repo_name;
    if (patch.summary !== undefined) set.summary = patch.summary;
    await this.db
      .update(knowledgeCodeGraph)
      .set(set)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
        ),
      )
      .execute();
    return this.getCodeGraphById(serviceId, codeGraphId);
  }

  // ═══════════════════════ Wiki ═══════════════════════

  async createWiki(input: CreateWikiInput): Promise<CreateResult<WikiRow>> {
    const existing = (
      await this.db
        .select()
        .from(knowledgeWiki)
        .where(
          and(
            eq(knowledgeWiki.serviceId, input.service_id),
            eq(knowledgeWiki.teamId, input.team_id),
            eq(knowledgeWiki.name, input.name),
            isNull(knowledgeWiki.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { row: this.mapWikiRow(existing), existed: true };

    const ts = nowIso();
    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const id = genWikiId();
      try {
        await this.db
          .insert(knowledgeWiki)
          .values({
            wikiId: id,
            serviceId: input.service_id,
            teamId: input.team_id,
            name: input.name,
            sourceType: input.source_type ?? null,
            sourceUrl: input.source_url ?? null,
            ownerUserId: input.owner_user_id ?? null,
            userId: input.user_id ?? null,
            agentId: input.agent_id ?? null,
            taskId: input.task_id ?? null,
            visibility: input.visibility ?? "team",
            status: "draft",
            serviceUrl: input.service_url ?? null,
            version: WIKI_DATA_VERSION,
            createdAt: ts,
            updatedAt: ts,
          })
          .execute();

        const row = (
          await this.db
            .select()
            .from(knowledgeWiki)
            .where(eq(knowledgeWiki.wikiId, id))
            .limit(1)
        )[0];
        return { row: this.mapWikiRow(row!), existed: false };
      } catch (err) {
        const raced = (
          await this.db
            .select()
            .from(knowledgeWiki)
            .where(
              and(
                eq(knowledgeWiki.serviceId, input.service_id),
                eq(knowledgeWiki.teamId, input.team_id),
                eq(knowledgeWiki.name, input.name),
                isNull(knowledgeWiki.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (raced) return { row: this.mapWikiRow(raced), existed: true };
        if (!isUniqueViolation(err) || attempt === ID_RETRY - 1) throw err;
      }
    }
    throw new Error("createWiki: failed to allocate unique id");
  }

  async getWiki(
    serviceId: string,
    teamId: string,
    wikiId: string,
  ): Promise<WikiRow | null> {
    const row = (
      await this.db
        .select()
        .from(knowledgeWiki)
        .where(
          and(
            eq(knowledgeWiki.wikiId, wikiId),
            eq(knowledgeWiki.serviceId, serviceId),
            eq(knowledgeWiki.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    return row ? this.mapWikiRow(row) : null;
  }

  /** id-only accessor — STILL scoped by service_id (cross-Memory leak guard, 001 §2.4). */
  async getWikiById(
    serviceId: string,
    wikiId: string,
  ): Promise<WikiRow | null> {
    const row = (
      await this.db
        .select()
        .from(knowledgeWiki)
        .where(
          and(
            eq(knowledgeWiki.wikiId, wikiId),
            eq(knowledgeWiki.serviceId, serviceId),
          ),
        )
        .limit(1)
    )[0];
    return row ? this.mapWikiRow(row) : null;
  }

  async listWikis(
    serviceId: string,
    teamId: string,
    opts?: ListOpts,
  ): Promise<WikiRow[]> {
    const conditions: SQL[] = [
      eq(knowledgeWiki.serviceId, serviceId),
      eq(knowledgeWiki.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeWiki.status, opts.syncStatus));
    }
    const rows = await this.db
      .select()
      .from(knowledgeWiki)
      .where(and(...conditions))
      .orderBy(desc(knowledgeWiki.updatedAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0);
    return rows.map((r) => this.mapWikiRow(r));
  }

  async countWikis(
    serviceId: string,
    teamId: string,
    opts?: CountOpts,
  ): Promise<number> {
    const conditions: SQL[] = [
      eq(knowledgeWiki.serviceId, serviceId),
      eq(knowledgeWiki.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeWiki.status, opts.syncStatus));
    }
    const result = (
      await this.db
        .select({ total: sql<number>`count(*)` })
        .from(knowledgeWiki)
        .where(and(...conditions))
        .limit(1)
    )[0];
    return Number(result?.total ?? 0);
  }

  /** id-only mutation — scoped by service_id so a foreign tenant cannot mutate. */
  async updateWikiStatus(
    serviceId: string,
    wikiId: string,
    patch: WikiStatusPatch,
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.internal_status !== undefined)
      set.internalStatus = patch.internal_status;
    if (patch.sync_error !== undefined) set.syncError = patch.sync_error;
    if (patch.page_count !== undefined) set.pageCount = patch.page_count;
    if (patch.last_sync_at !== undefined) set.lastSyncAt = patch.last_sync_at;
    if (patch.service_url !== undefined) set.serviceUrl = patch.service_url;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.version !== undefined) set.version = patch.version;

    await this.db
      .update(knowledgeWiki)
      .set(set)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
        ),
      )
      .execute();
  }

  async deleteWiki(
    serviceId: string,
    teamId: string,
    wikiId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([serviceId, teamId, wikiId])}))`,
      );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"knowledge/" + [serviceId, teamId, wikiId].join("/")}))`,
      );
      const result = await tx
        .delete(knowledgeWiki)
        .where(
          and(
            eq(knowledgeWiki.wikiId, wikiId),
            eq(knowledgeWiki.serviceId, serviceId),
            eq(knowledgeWiki.teamId, teamId),
          ),
        )
        .execute();
      if (!(result.rowCount ?? 0)) return false;
      await tx.execute(
        sql`DELETE FROM knowledge_source_credential WHERE service_id=${serviceId} AND resource_type=${"wiki"} AND resource_id=${wikiId}`,
      );
      await tx.execute(
        sql`DELETE FROM knowledge_artifact_scope WHERE namespace='knowledge' AND scope=${[serviceId, teamId, wikiId].join("/")}`,
      );
      const key = JSON.stringify([serviceId, teamId, wikiId]);
      await tx.execute(
        sql`DELETE FROM knowledge_wiki_page WHERE wiki_key=${key}`,
      );
      await tx.execute(
        sql`DELETE FROM knowledge_wiki_edge WHERE wiki_key=${key}`,
      );
      await tx.execute(
        sql`DELETE FROM knowledge_wiki_source WHERE wiki_key=${key}`,
      );
      return true;
    });
  }

  /** Update wiki metadata (name, summary). memory mismatch → null. */
  async updateWikiMeta(
    serviceId: string,
    wikiId: string,
    patch: WikiMetaPatch,
  ): Promise<WikiRow | null> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.summary !== undefined) set.summary = patch.summary;
    await this.db
      .update(knowledgeWiki)
      .set(set)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
        ),
      )
      .execute();
    return this.getWikiById(serviceId, wikiId);
  }

  // ═══════════════════════ Audit ═══════════════════════

  async appendWikiAudit(input: AuditLogInput): Promise<void> {
    await this.db
      .insert(knowledgeWikiAudit)
      .values({
        wikiId: input.asset_id,
        serviceId: input.service_id ?? null,
        version: input.version,
        action: input.action,
        userId: input.user_id ?? null,
        agentId: input.agent_id ?? null,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      })
      .execute();
  }

  async appendCodeGraphAudit(input: AuditLogInput): Promise<void> {
    await this.db
      .insert(knowledgeCodeGraphAudit)
      .values({
        codeGraphId: input.asset_id,
        serviceId: input.service_id ?? null,
        version: input.version,
        action: input.action,
        userId: input.user_id ?? null,
        agentId: input.agent_id ?? null,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      })
      .execute();
  }

  async listWikiAudit(
    serviceId: string,
    wikiId: string,
    limit = 20,
    offset = 0,
  ): Promise<AuditLogRow[]> {
    const rows = await this.db
      .select()
      .from(knowledgeWikiAudit)
      .where(
        and(
          eq(knowledgeWikiAudit.wikiId, wikiId),
          eq(knowledgeWikiAudit.serviceId, serviceId),
        ),
      )
      .orderBy(desc(knowledgeWikiAudit.version), desc(knowledgeWikiAudit.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      service_id: r.serviceId ?? null,
      asset_id: r.wikiId,
      version: r.version,
      action: r.action as AuditLogRow["action"],
      user_id: r.userId,
      agent_id: r.agentId,
      detail: r.detail,
      created_at: r.createdAt,
    }));
  }

  async listCodeGraphAudit(
    serviceId: string,
    codeGraphId: string,
    limit = 20,
    offset = 0,
  ): Promise<AuditLogRow[]> {
    const rows = await this.db
      .select()
      .from(knowledgeCodeGraphAudit)
      .where(
        and(
          eq(knowledgeCodeGraphAudit.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraphAudit.serviceId, serviceId),
        ),
      )
      .orderBy(
        desc(knowledgeCodeGraphAudit.version),
        desc(knowledgeCodeGraphAudit.id),
      )
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      service_id: r.serviceId ?? null,
      asset_id: r.codeGraphId,
      version: r.version,
      action: r.action as AuditLogRow["action"],
      user_id: r.userId,
      agent_id: r.agentId,
      detail: r.detail,
      created_at: r.createdAt,
    }));
  }

  // ═══════════════════════ Restart Recovery ═══════════════════════

  /**
   * Sweep all non-terminal (pending/processing) assets to failed, across all tenants.
   * After restart, in-memory SerialQueue tasks are lost; this makes them visible to control plane.
   * @returns total affected rows (code + wiki combined).
   */
  async markInterruptedAsFailed(
    reason = "interrupted by restart",
  ): Promise<number> {
    const ts = nowIso();
    const a = await this.db
      .update(knowledgeCodeGraph)
      .set({ status: "failed", syncError: reason, updatedAt: ts })
      .where(sql`status IN ('pending','processing')`)
      .execute();
    const b = await this.db
      .update(knowledgeWiki)
      .set({ status: "failed", syncError: reason, updatedAt: ts })
      .where(sql`status IN ('pending','processing')`)
      .execute();
    return (a.rowCount ?? 0) + (b.rowCount ?? 0);
  }

  /** All ready code-graphs (with service_id) so module.ts can rebuild per-tenant dirs. */
  async listSyncedCodeGraphs(): Promise<SyncedCodeGraphRef[]> {
    return await this.db
      .select({
        code_graph_id: knowledgeCodeGraph.codeGraphId,
        service_id: knowledgeCodeGraph.serviceId,
        team_id: knowledgeCodeGraph.teamId,
      })
      .from(knowledgeCodeGraph)
      .where(
        and(
          eq(knowledgeCodeGraph.status, "ready"),
          isNull(knowledgeCodeGraph.deletedAt),
        ),
      );
  }

  async listSyncedWikis(): Promise<SyncedWikiRef[]> {
    return await this.db
      .select({
        wiki_id: knowledgeWiki.wikiId,
        service_id: knowledgeWiki.serviceId,
        team_id: knowledgeWiki.teamId,
      })
      .from(knowledgeWiki)
      .where(
        and(eq(knowledgeWiki.status, "ready"), isNull(knowledgeWiki.deletedAt)),
      );
  }

  // ═══════════════════════ Mappers ═══════════════════════

  private mapCgRow(r: typeof knowledgeCodeGraph.$inferSelect): CodeGraphRow {
    return {
      code_graph_id: r.codeGraphId,
      service_id: r.serviceId,
      team_id: r.teamId,
      repo_name: r.repoName,
      repo_url: r.repoUrl,
      branch: r.branch,
      commit_hash: r.commitHash,
      owner_user_id: r.ownerUserId,
      user_id: r.userId,
      agent_id: r.agentId,
      task_id: r.taskId,
      visibility: r.visibility,
      status: r.status as SyncStatus,
      internal_status: r.internalStatus,
      sync_error: r.syncError,
      stats_json: r.statsJson,
      service_url: r.serviceUrl ?? null,
      summary: r.summary ?? null,
      version: r.version,
      last_sync_at: r.lastSyncAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt ?? null,
    };
  }

  private mapWikiRow(r: typeof knowledgeWiki.$inferSelect): WikiRow {
    return {
      wiki_id: r.wikiId,
      service_id: r.serviceId,
      team_id: r.teamId,
      name: r.name,
      source_type: r.sourceType,
      source_url: r.sourceUrl,
      owner_user_id: r.ownerUserId,
      user_id: r.userId,
      agent_id: r.agentId,
      task_id: r.taskId,
      visibility: r.visibility,
      status: r.status as SyncStatus,
      internal_status: r.internalStatus,
      sync_error: r.syncError,
      page_count: r.pageCount,
      service_url: r.serviceUrl ?? null,
      summary: r.summary ?? null,
      version: r.version,
      last_sync_at: r.lastSyncAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt ?? null,
    };
  }
}
