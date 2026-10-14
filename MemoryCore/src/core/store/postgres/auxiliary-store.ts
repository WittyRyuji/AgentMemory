import type { PostgresDatabase } from "./client.js";
import { PostgresDocuments, Where } from "./documents.js";
import type {
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  BatchDeleteResult,
} from "../types.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLayer,
  type MemoryGenerationRefRecord,
} from "../../memory-generation-log/types.js";
import type {
  MemoryPromptRecord,
  MemoryPromptListFilter,
  MemoryPromptSettingRecord,
  MemoryPromptSettingListFilter,
  MemoryPromptSettingLogRecord,
  MemoryPromptSettingLogFilter,
  MemoryPromptDeleteResult,
} from "../../memory-prompt/types.js";

/** Non-vector records remain in PostgreSQL alongside the memory rows. */
export class PostgresAuxiliaryStore {
  protected readonly docs: PostgresDocuments;
  constructor(protected readonly db: PostgresDatabase) {
    this.docs = new PostgresDocuments(db);
  }
  async createKnowledge(
    input: Omit<KnowledgeEntity, "created_at" | "updated_at">,
  ): Promise<KnowledgeEntity> {
    const now = new Date().toISOString(),
      record = { ...input, created_at: now, updated_at: now };
    return this.db.transaction(async () => {
      const old = await this.getKnowledge(input.knowledge_id);
      if (old) record.created_at = old.created_at;
      await this.docs.put("knowledge", input.knowledge_id, record);
      return record;
    }, true);
  }
  getKnowledge(id: string) {
    return this.docs.get<KnowledgeEntity>("knowledge", id);
  }
  async updateKnowledge(
    id: string,
    patch: Partial<
      Pick<
        KnowledgeEntity,
        "name" | "summary" | "service_url" | "repo_url" | "branch"
      >
    >,
  ) {
    return this.db.transaction(async () => {
      const old = await this.getKnowledge(id);
      if (!old) return null;
      const record = { ...old, ...patch, updated_at: new Date().toISOString() };
      await this.docs.put("knowledge", id, record);
      return record;
    }, true);
  }
  async deleteKnowledge(
    ids: string[],
    teamId?: string,
  ): Promise<BatchDeleteResult> {
    return this.db.transaction(async () => {
      const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
      for (const id of ids) {
        if (
          await this.docs.delete(
            "knowledge",
            new Where().ids([id]).add("team_id", teamId),
          )
        )
          result.deleted_ids.push(id);
        else result.failed.push({ id, reason: "not_found" });
      }
      return result;
    }, true);
  }
  async listKnowledge(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeListResult> {
    const w = new Where().add("team_id", input.team_id).add("type", input.type);
    if (input.knowledge_ids) w.ids(input.knowledge_ids);
    return {
      items: await this.docs.list<KnowledgeEntity>("knowledge", w, {
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
        order: "updated_at",
      }),
      total: await this.docs.count("knowledge", w),
    };
  }
  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]) {
    await this.db.transaction(async () => {
      for (const r of records)
        await this.docs.put(
          "generation_refs",
          buildMemoryGenerationRefId(r.layer, r.memory_id),
          r,
        );
    });
  }
  getMemoryGenerationRef(layer: MemoryGenerationLayer, id: string) {
    return this.docs.get<MemoryGenerationRefRecord>(
      "generation_refs",
      buildMemoryGenerationRefId(layer, id),
    );
  }
  countMemoryPrompts() {
    return this.docs.count("prompts");
  }
  async createMemoryPrompt(r: MemoryPromptRecord) {
    await this.docs.put("prompts", r.memory_prompt_id, r);
    return r;
  }
  async getMemoryPrompts(ids: string[]) {
    const rows = await this.docs.list<MemoryPromptRecord>(
      "prompts",
      new Where().ids(ids),
    );
    const map = new Map(rows.map((r) => [r.memory_prompt_id, r]));
    return ids.flatMap((id) => (map.has(id) ? [map.get(id)!] : []));
  }
  private pagination(
    f: { limit?: number; offset?: number; timeOrder?: string },
    field = "updated_at_ms",
  ) {
    return {
      order: field,
      numeric: true,
      asc: f.timeOrder === "asc",
      limit: Math.min(Math.max(f.limit ?? 20, 1), 100),
      offset: Math.max(f.offset ?? 0, 0),
    };
  }
  listMemoryPrompts(f: MemoryPromptListFilter) {
    return this.docs.list<MemoryPromptRecord>(
      "prompts",
      new Where().add("status", "active").add("layer", f.layer),
      this.pagination(f),
    );
  }
  async updateMemoryPrompt(
    id: string,
    patch: {
      name?: string;
      prompt?: string;
      updated_by?: string;
      updated_at_ms: number;
    },
  ) {
    return this.db.transaction(async () => {
      const old = await this.docs.get<MemoryPromptRecord>("prompts", id);
      if (!old || old.status !== "active") return null;
      if (
        (patch.name === undefined || patch.name === old.name) &&
        (patch.prompt === undefined || patch.prompt === old.prompt)
      )
        return old;
      const r = { ...old, ...patch, version: old.version + 1 };
      await this.docs.put("prompts", id, r);
      return r;
    }, true);
  }
  async getMemoryPromptSettings(ids: string[]) {
    const rows = await this.docs.list<MemoryPromptSettingRecord>(
      "prompt_settings",
      new Where().ids(ids),
    );
    const map = new Map(rows.map((r) => [r.setting_id, r]));
    return ids.flatMap((id) => (map.has(id) ? [map.get(id)!] : []));
  }
  listMemoryPromptSettings(f: MemoryPromptSettingListFilter) {
    return this.docs.list<MemoryPromptSettingRecord>(
      "prompt_settings",
      new Where()
        .add("memory_prompt_id", f.memoryPromptId)
        .add("target_type", f.targetType)
        .add("team_id", f.teamId)
        .add("agent_id", f.agentId)
        .add("layer", f.layer),
      this.pagination(f),
    );
  }
  async upsertMemoryPromptSettings(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ) {
    await this.db.transaction(async () => {
      for (const r of records)
        await this.docs.put("prompt_settings", r.setting_id, r);
      for (const r of logs)
        await this.docs.put("prompt_logs", r.setting_log_id, r);
    }, true);
  }
  async clearMemoryPromptSettings(
    ids: string[],
    logs: MemoryPromptSettingLogRecord[],
  ) {
    await this.db.transaction(async () => {
      await this.docs.delete("prompt_settings", new Where().ids(ids));
      for (const r of logs)
        await this.docs.put("prompt_logs", r.setting_log_id, r);
    }, true);
  }
  async deleteMemoryPrompts(
    ids: string[],
    operatorId?: string,
  ): Promise<MemoryPromptDeleteResult> {
    return this.db.transaction(async () => {
      const cleared = { instance: 0, team: 0, agent: 0 };
      const unique = [...new Set(ids)];
      if ((await this.getMemoryPrompts(unique)).length !== unique.length)
        return { deleted_prompt_ids: [], cleared_settings: cleared };
      // Exact containment is evaluated in PostgreSQL; do not load other instances or all settings.
      const w = new Where();
      w.values.push(unique);
      w.parts.push(`data->>'memory_prompt_id'=ANY($1::text[])`);
      const settings = await this.docs.list<MemoryPromptSettingRecord>(
        "prompt_settings",
        w,
      );
      for (const setting of settings) {
        cleared[setting.target_type]++;
        const log: MemoryPromptSettingLogRecord = {
          setting_log_id: `mpsl:delete:${setting.setting_id}:${setting.memory_prompt_id}`,
          target_type: setting.target_type,
          team_id: setting.team_id,
          agent_id: setting.agent_id,
          layer: setting.layer,
          action: "clear",
          reason: "prompt_deleted",
          before_memory_prompt_id: setting.memory_prompt_id,
          operator_id: operatorId,
          operated_at_ms: Date.now(),
        };
        await this.docs.put("prompt_logs", log.setting_log_id, log);
      }
      await this.docs.delete("prompt_settings", w);
      await this.docs.delete("prompts", new Where().ids(unique));
      return { deleted_prompt_ids: unique, cleared_settings: cleared };
    }, true);
  }
  queryMemoryPromptSettingLogs(f: MemoryPromptSettingLogFilter) {
    const w = new Where()
      .add("team_id", f.teamId)
      .add("agent_id", f.agentId)
      .add("action", f.action)
      .add("operated_at_ms", f.startTimeMs, ">=")
      .add("operated_at_ms", f.endTimeMs, "<=");
    if (f.memoryPromptId) {
      w.values.push(f.memoryPromptId);
      w.parts.push(
        `(data->>'before_memory_prompt_id'=$${w.values.length} OR data->>'after_memory_prompt_id'=$${w.values.length})`,
      );
    }
    return this.docs.list<MemoryPromptSettingLogRecord>(
      "prompt_logs",
      w,
      this.pagination(f, "operated_at_ms"),
    );
  }
}
