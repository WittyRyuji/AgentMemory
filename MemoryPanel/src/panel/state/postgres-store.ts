import { Pool } from 'pg';
import type { IdentityBinding, IdentityStore } from '../auth/identity-store.js';
import type { AgentTemplateConfig, AgentTemplateStore } from './agent-template-store.js';

/** Minimal injectable query interface used by the PostgreSQL-engine tests. */
export interface PanelSql {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export const PANEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS panel_identities (
  instance_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  external_subject TEXT NOT NULL,
  binding JSONB NOT NULL,
  PRIMARY KEY (instance_id, provider_id, external_subject)
);
CREATE TABLE IF NOT EXISTS panel_agent_templates (
  instance_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  config JSONB NOT NULL,
  PRIMARY KEY (instance_id, team_id)
);`;

/** Authoritative state: every read/write reaches PG, with no process-local cache. */
export class PostgresPanelStore {
  readonly identities: IdentityStore;
  readonly templates: AgentTemplateStore;

  constructor(readonly sql: PanelSql, private readonly end?: () => Promise<void>) {
    this.identities = {
      strictPersistence: true,
      find: async (instanceId, providerId, externalSubject) => {
        const result = await this.sql.query(
          'SELECT binding FROM panel_identities WHERE instance_id=$1 AND provider_id=$2 AND external_subject=$3',
          [instanceId, providerId, externalSubject],
        );
        return (result.rows[0]?.binding as unknown as IdentityBinding | undefined) ?? null;
      },
      save: async (binding) => {
        await this.sql.query(
          `INSERT INTO panel_identities (instance_id, provider_id, external_subject, binding) VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (instance_id, provider_id, external_subject) DO UPDATE SET binding=EXCLUDED.binding`,
          [binding.instanceId, binding.providerId, binding.externalSubject, JSON.stringify(binding)],
        );
      },
    };
    this.templates = {
      get: async (instanceId, teamId) => {
        const result = await this.sql.query(
          'SELECT config FROM panel_agent_templates WHERE instance_id=$1 AND team_id=$2', [instanceId, teamId],
        );
        return (result.rows[0]?.config as unknown as AgentTemplateConfig | undefined) ?? null;
      },
      save: async (instanceId, teamId, config) => {
        await this.sql.query(
          `INSERT INTO panel_agent_templates (instance_id, team_id, config) VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (instance_id, team_id) DO UPDATE SET config=EXCLUDED.config`,
          [instanceId, teamId, JSON.stringify(config)],
        );
      },
    };
  }

  async initialize(): Promise<void> { await this.sql.query(PANEL_SCHEMA_SQL); }
  async close(): Promise<void> { await this.end?.(); }
}

export function openPostgresPanelStore(connectionString: string): PostgresPanelStore {
  if (!connectionString.trim()) throw new Error('Panel PostgreSQL URL is required');
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => console.error('[panel-state] PostgreSQL idle connection failed'));
  return new PostgresPanelStore(pool as PanelSql, () => pool.end());
}
