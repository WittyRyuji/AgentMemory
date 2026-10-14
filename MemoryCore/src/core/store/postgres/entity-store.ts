/** Legacy v2 entity APIs retained alongside the authoritative v3 metadata adapter. */
import { randomUUID } from "node:crypto";
import type {
  IMemoryStore,
  TeamEntity,
  UserEntity,
  AgentEntity,
  TaskEntity,
  BatchDeleteResult,
} from "../types.js";
import { Where } from "./documents.js";
import { PostgresAuxiliaryStore } from "./auxiliary-store.js";
export class PostgresEntityStore extends PostgresAuxiliaryStore {
  private id(prefix: string) {
    return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  }
  private async insert<T>(kind: string, id: string, value: T): Promise<T> {
    return this.db.transaction(async () => {
      if (await this.docs.get(kind, id))
        throw new Error("Entity ID already exists");
      await this.docs.put(kind, id, value);
      return value;
    }, true);
  }
  private async patch<T extends { updated_at: string }>(
    kind: string,
    id: string,
    patch: Partial<T>,
  ): Promise<T | null> {
    return this.db.transaction(async () => {
      const old = await this.docs.get<T>(kind, id);
      if (!old) return null;
      const next = { ...old, ...patch, updated_at: new Date().toISOString() };
      await this.docs.put(kind, id, next);
      return next;
    }, true);
  }
  private async removeEntities(
    kind: string,
    ids: string[],
    status?: string,
  ): Promise<BatchDeleteResult> {
    return this.db.transaction(async () => {
      const r: BatchDeleteResult = { deleted_ids: [], failed: [] };
      for (const id of ids) {
        const old = await this.docs.get<Record<string, unknown>>(kind, id);
        if (!old) {
          r.failed.push({ id, reason: "not_found" });
          continue;
        }
        if (status)
          await this.docs.put(kind, id, {
            ...old,
            status,
            updated_at: new Date().toISOString(),
          });
        else await this.docs.delete(kind, new Where().ids([id]));
        r.deleted_ids.push(id);
      }
      return r;
    }, true);
  }
  createTeam: NonNullable<IMemoryStore["createTeam"]> = async (input) => {
    const now = new Date().toISOString(),
      id = input.team_id || this.id("team");
    await this.insert("teams", id, {
      ...input,
      team_id: id,
      user_ids: [input.owner_user_id],
      agent_ids: [],
      status: input.status ?? "active",
      created_at: now,
      updated_at: now,
    });
    return (await this.getTeam(id))!;
  };
  async getTeam(id: string): Promise<TeamEntity | null> {
    const r = await this.docs.get<TeamEntity>("teams", id);
    if (!r) return null;
    const agents = await this.docs.list<AgentEntity>(
      "agents",
      new Where().add("team_id", id).add("status", "active"),
    );
    const tasks = await this.docs.list<TaskEntity>(
      "tasks",
      new Where().add("team_id", id),
    );
    return {
      ...r,
      user_ids: [...new Set([...(r.user_ids ?? []), r.owner_user_id])].sort(),
      agent_ids: [
        ...new Set([...(r.agent_ids ?? []), ...agents.map((a) => a.agent_id)]),
      ].sort(),
      task_ids: tasks.map((t) => t.task_id).sort(),
    };
  }
  updateTeam: NonNullable<IMemoryStore["updateTeam"]> = async (id, patch) =>
    this.db.transaction(async () => {
      const old = await this.getTeam(id);
      if (!old) return null;
      const owner = patch.owner_user_id ?? old.owner_user_id;
      await this.patch<TeamEntity>("teams", id, {
        ...patch,
        user_ids: [
          ...new Set([...(patch.user_ids ?? old.user_ids ?? []), owner]),
        ].sort(),
      });
      return this.getTeam(id);
    }, true);
  deleteTeams(ids: string[]) {
    return this.removeEntities("teams", ids, "archived");
  }
  createUser: NonNullable<IMemoryStore["createUser"]> = async (input) => {
    const now = new Date().toISOString(),
      id = input.user_id || this.id("user");
    return this.insert<UserEntity>("users", id, {
      ...input,
      user_id: id,
      status: input.status ?? "active",
      team_ids: [],
      task_ids: [],
      owned_agent_ids: [],
      task_agent_ids: [],
      created_at: now,
      updated_at: now,
    });
  };
  async getUser(id: string): Promise<UserEntity | null> {
    const r = await this.docs.get<UserEntity>("users", id);
    if (!r) return null;
    const teams = (
      await this.docs.list<TeamEntity>(
        "teams",
        new Where().add("status", "active"),
      )
    ).filter((t) => t.owner_user_id === id || t.user_ids?.includes(id));
    const tasks = (await this.docs.list<TaskEntity>("tasks")).filter(
      (t) => t.creator_user_id === id || t.user_ids.includes(id),
    );
    const agents = await this.docs.list<AgentEntity>(
      "agents",
      new Where().add("owner_user_id", id).add("status", "active"),
    );
    return {
      ...r,
      team_ids: teams.map((t) => t.team_id).sort(),
      task_ids: tasks.map((t) => t.task_id).sort(),
      task_agent_ids: [...new Set(tasks.flatMap((t) => t.agent_ids))].sort(),
      owned_agent_ids: agents.map((a) => a.agent_id).sort(),
    };
  }
  updateUser: NonNullable<IMemoryStore["updateUser"]> = async (id, p) => {
    await this.patch<UserEntity>("users", id, p);
    return this.getUser(id);
  };
  deleteUsers(ids: string[]) {
    return this.removeEntities("users", ids, "inactive");
  }
  createAgent: NonNullable<IMemoryStore["createAgent"]> = async (input) =>
    this.db.transaction(async () => {
      const now = new Date().toISOString(),
        id = input.agent_id || this.id("agent");
      await this.insert<AgentEntity>("agents", id, {
        ...input,
        agent_id: id,
        status: input.status ?? "active",
        visibility: input.visibility ?? "team",
        created_at: now,
        updated_at: now,
      });
      const team = await this.getTeam(input.team_id);
      if (team)
        await this.updateTeam(input.team_id, {
          agent_ids: [...new Set([...(team.agent_ids ?? []), id])],
        });
      return (await this.getAgent(id))!;
    }, true);
  async getAgent(id: string): Promise<AgentEntity | null> {
    const r = await this.docs.get<AgentEntity>("agents", id);
    if (!r) return null;
    const tasks = (await this.docs.list<TaskEntity>("tasks")).filter((t) =>
      t.agent_ids.includes(id),
    );
    return { ...r, task_ids: tasks.map((t) => t.task_id).sort() };
  }
  updateAgent: NonNullable<IMemoryStore["updateAgent"]> = async (id, p) => {
    await this.patch<AgentEntity>("agents", id, p);
    return this.getAgent(id);
  };
  deleteAgents(ids: string[]) {
    return this.removeEntities("agents", ids, "inactive");
  }
  createTask: NonNullable<IMemoryStore["createTask"]> = async (input) => {
    const now = new Date().toISOString(),
      id = input.task_id || this.id("task");
    return this.insert<TaskEntity>("tasks", id, {
      ...input,
      task_id: id,
      source_type: input.source_type ?? "manual",
      agent_ids: input.agent_ids ?? [],
      user_ids: input.user_ids ?? [],
      created_at: now,
      updated_at: now,
    });
  };
  getTask(id: string) {
    return this.docs.get<TaskEntity>("tasks", id);
  }
  updateTask: NonNullable<IMemoryStore["updateTask"]> = async (id, p) =>
    this.patch<TaskEntity>("tasks", id, p);
  deleteTasks(ids: string[]) {
    return this.removeEntities("tasks", ids);
  }
}
