import { randomUUID } from "node:crypto";
import type {
  ISkillStore,
  SkillSearchResult,
  ExpiredVersionMeta,
} from "../../skill/skill-store.interface.js";
import { SkillStoreError } from "../../skill/skill-store.interface.js";
import type {
  Skill,
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
} from "../../skill/types.js";
import type { EmbeddingService } from "../embedding.js";
import { tokenizeForFts } from "../tokenize.js";
import { PostgresDatabase } from "./client.js";
import { PostgresDocuments, Where } from "./documents.js";
import { vectorLiteral } from "./memory-store.js";

export class PostgresSkillStore implements ISkillStore {
  private readonly docs: PostgresDocuments;
  private ready = false;
  private starting?: Promise<void>;
  constructor(
    private readonly db: PostgresDatabase,
    private readonly embedding: EmbeddingService,
  ) {
    this.docs = new PostgresDocuments(db);
  }
  init(): void {
    void this.initialize().catch(() => {});
  }
  async initialize(): Promise<void> {
    this.starting ??= this.db
      .transaction(async () => {
        await this.docs.init();
        const dimensions = this.embedding.getDimensions();
        if (
          !Number.isInteger(dimensions) ||
          dimensions < 1 ||
          dimensions > 16000
        )
          throw new Error("Invalid skill embedding dimension");
        await this.db
          .exec(`CREATE TABLE IF NOT EXISTS skill_search (row_id TEXT PRIMARY KEY, embedding vector(${dimensions}), search TSVECTOR NOT NULL);
      CREATE INDEX IF NOT EXISTS skill_search_fts ON skill_search USING GIN(search);
      CREATE UNIQUE INDEX IF NOT EXISTS skill_version_unique ON memory_documents ((data->>'team_id'),(data->>'skill_id'),((data->>'version')::int)) WHERE kind='skills';
      CREATE UNIQUE INDEX IF NOT EXISTS skill_head_unique ON memory_documents ((data->>'team_id'),(data->>'skill_id')) WHERE kind='skills' AND data->>'is_head'='true';
      CREATE UNIQUE INDEX IF NOT EXISTS skill_name_unique ON memory_documents ((data->>'team_id'),(data->>'owner_agent_id'),(data->>'name')) WHERE kind='skills' AND data->>'is_head'='true' AND data->>'status'='active';`);
        this.ready = true;
      }, true)
      .catch((error) => {
        this.starting = undefined;
        throw error;
      });
    return this.starting;
  }
  isDegraded() {
    return !this.ready;
  }
  getCapabilities() {
    return {
      vectorSearch: this.ready,
      ftsSearch: this.ready,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }
  close() {
    this.ready = false;
  }
  private scope(skillId: string, teamId?: string) {
    return new Where().add("skill_id", skillId).add("team_id", teamId);
  }
  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    await this.initialize();
    const embedding = vectorLiteral(
      await this.embedding.embed(
        `${input.name}\n${input.description}\n${input.content}`,
      ),
      this.embedding.getDimensions(),
    );
    return this.db.transaction(async () => {
      const team = input.team_id ?? "default",
        head = await this.getHeadIncludingArchived(input.skill_id, team);
      const owner = head?.owner_agent_id ?? input.owner_agent_id ?? "default";
      if (head && head.name !== input.name)
        throw new SkillStoreError(
          "SKILL_NAME_DUPLICATE",
          "name changes across versions are not allowed",
        );
      const collision = (
        await this.docs.list<Skill>(
          "skills",
          new Where()
            .add("team_id", team)
            .add("owner_agent_id", owner)
            .add("name", input.name)
            .add("is_head", "true")
            .add("status", "active"),
        )
      ).find((r) => r.skill_id !== input.skill_id);
      if (collision) throw new SkillStoreError("SKILL_NAME_DUPLICATE");
      if (head)
        await this.docs.put("skills", head.row_id, { ...head, is_head: false });
      const now = Date.now(),
        version = (head?.version ?? 0) + 1;
      const skill: Skill = {
        row_id: randomUUID(),
        skill_id: input.skill_id,
        version,
        is_head: true,
        team_id: team,
        owner_agent_id: owner,
        user_id: input.user_id ?? "default",
        task_id: input.task_id ?? "default",
        name: input.name,
        description: input.description,
        content: input.content,
        content_hash: input.content_hash,
        manifest: input.manifest,
        storage_dir: input.storage_dir,
        status: "active",
        metadata_json: input.metadata_json ?? "{}",
        created_at_ms: now,
        updated_at_ms: now,
      };
      await this.docs.put("skills", skill.row_id, skill);
      await this.db.query(
        "INSERT INTO skill_search(row_id,embedding,search) VALUES($1,$2::vector,to_tsvector('simple',$3))",
        [
          skill.row_id,
          embedding,
          tokenizeForFts(`${skill.name} ${skill.description} ${skill.content}`),
        ],
      );
      return skill;
    }, true);
  }
  async getHead(skillId: string, teamId?: string) {
    await this.initialize();
    return (
      (
        await this.docs.list<Skill>(
          "skills",
          this.scope(skillId, teamId)
            .add("is_head", "true")
            .add("status", "active"),
        )
      )[0] ?? null
    );
  }
  async getHeadIncludingArchived(skillId: string, teamId?: string) {
    await this.initialize();
    return (
      (
        await this.docs.list<Skill>(
          "skills",
          this.scope(skillId, teamId).add("is_head", "true"),
        )
      )[0] ?? null
    );
  }
  async getByVersion(skillId: string, version: number, teamId?: string) {
    await this.initialize();
    return (
      (
        await this.docs.list<Skill>(
          "skills",
          this.scope(skillId, teamId).add("version", version),
        )
      )[0] ?? null
    );
  }
  async archiveHead(skillId: string, teamId?: string) {
    await this.initialize();
    return this.db.transaction(async () => {
      const head = await this.getHead(skillId, teamId);
      if (!head) return { archived: false };
      await this.docs.put("skills", head.row_id, {
        ...head,
        status: "archived",
        updated_at_ms: Date.now(),
      });
      return { archived: true };
    }, true);
  }
  async listSkills(f: ListSkillsOptions) {
    await this.initialize();
    const w = new Where()
      .add("is_head", "true")
      .add("team_id", f.team_id)
      .add("owner_agent_id", f.owner_agent_id)
      .add("user_id", f.user_id)
      .add("task_id", f.task_id)
      .prefix("name", f.name_prefix);
    w.values.push(f.status?.length ? f.status : ["active"]);
    w.parts.push(`data->>'status'=ANY($${w.values.length}::text[])`);
    return {
      total: await this.docs.count("skills", w),
      items: await this.docs.list<Skill>("skills", w, {
        order: "updated_at_ms",
        numeric: true,
        limit: Math.min(Math.max(f.limit ?? 50, 1), 1000),
        offset: Math.max(f.offset ?? 0, 0),
      }),
    };
  }
  async searchSkills(f: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    await this.initialize();
    const w = new Where()
        .add("team_id", f.team_id)
        .add("owner_agent_id", f.agent_id)
        .add("user_id", f.user_id)
        .add("task_id", f.task_id)
        .add("is_head", "true")
        .add("status", "active"),
      values = [...w.values];
    const mode = f.mode ?? "bm25";
    values.push(tokenizeForFts(f.query));
    const q = `plainto_tsquery('simple',$${values.length})`,
      fts = `ts_rank_cd(search,${q},32)`;
    let score = fts,
      predicate = `search @@ ${q}`;
    if (mode !== "bm25" && f.queryEmbedding) {
      values.push(
        vectorLiteral(f.queryEmbedding, this.embedding.getDimensions()),
      );
      const vector = `GREATEST(0,1-(embedding <=> $${values.length}::vector))`;
      score = mode === "hybrid" ? `(${fts}+${vector})/2` : vector;
      predicate = `embedding IS NOT NULL AND $${values.length - 1}::text IS NOT NULL`;
    }
    values.push(Math.min(Math.max(f.topK ?? 10, 1), 50));
    return (
      await this.db.query<{ data: Skill; score: number }>(
        `SELECT data,${score} AS score FROM memory_documents JOIN skill_search ON id=row_id WHERE kind='skills' AND ${w.sql()} AND ${predicate} ORDER BY score DESC,id LIMIT $${values.length}`,
        values,
      )
    ).rows.map((r) => ({
      skill: r.data,
      score: r.score,
      snippet: r.data.description.slice(0, 200),
    }));
  }
  async listVersions(
    skillId: string,
    teamId?: string,
    p?: { limit?: number; offset?: number },
  ) {
    await this.initialize();
    return this.docs.list<Skill>("skills", this.scope(skillId, teamId), {
      order: "version",
      numeric: true,
      limit: Math.min(Math.max(p?.limit ?? 50, 1), 1000),
      offset: Math.max(p?.offset ?? 0, 0),
    });
  }
  async countVersions(skillId: string, teamId?: string) {
    await this.initialize();
    return this.docs.count("skills", this.scope(skillId, teamId));
  }
  async findExpiredVersions(cutoff: number): Promise<ExpiredVersionMeta[]> {
    await this.initialize();
    return (
      await this.docs.list<Skill>(
        "skills",
        new Where().add("is_head", "false").add("created_at_ms", cutoff, "<"),
      )
    ).map((r) => ({
      skill_id: r.skill_id,
      version: r.version,
      storage_dir: r.storage_dir,
      created_at_ms: r.created_at_ms,
      is_head: r.is_head,
      status: r.status,
    }));
  }
  private async remove(w: Where) {
    const rows = await this.docs.list<Skill>("skills", w);
    await this.db.query(
      "DELETE FROM skill_search WHERE row_id=ANY($1::text[])",
      [rows.map((r) => r.row_id)],
    );
    return this.docs.delete("skills", w);
  }
  async deleteVersion(id: string, version: number) {
    await this.initialize();
    return this.db.transaction(
      async () =>
        (await this.remove(
          this.scope(id).add("version", version).add("is_head", "false"),
        )) > 0,
      true,
    );
  }
  async deleteAllVersions(id: string, teamId?: string) {
    await this.initialize();
    return this.db.transaction(() => this.remove(this.scope(id, teamId)), true);
  }
}
