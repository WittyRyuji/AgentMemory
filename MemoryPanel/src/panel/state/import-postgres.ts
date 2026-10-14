import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityBinding } from '../auth/identity-store.js';
import type { AgentTemplateConfig } from './agent-template-store.js';
import { PANEL_SCHEMA_SQL, PostgresPanelStore, type PanelSql } from './postgres-store.js';

export interface PanelSnapshot {
  identities: IdentityBinding[];
  templates: Array<{ instanceId: string; teamId: string; config: AgentTemplateConfig }>;
}

/** Read-only source scan; never creates or modifies a source file. */
export function readPanelSnapshot(identitiesPath?: string, templatesDir?: string): PanelSnapshot {
  const snapshot: PanelSnapshot = { identities: [], templates: [] };
  if (identitiesPath) {
    const data = JSON.parse(readFileSync(identitiesPath, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.bindings)) throw new Error('invalid identity file format');
    for (const binding of data.bindings) {
      if (!binding || !['instanceId', 'providerId', 'externalSubject', 'coreUserId', 'encryptedUserKey', 'updatedAt'].every(k => typeof binding[k] === 'string')) {
        throw new Error('invalid identity record; no rows imported');
      }
      snapshot.identities.push(binding);
    }
  }
  if (templatesDir) {
    for (const instance of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!instance.isDirectory()) throw new Error('unexpected entry in templates directory');
      for (const team of readdirSync(join(templatesDir, instance.name), { withFileTypes: true })) {
        if (!team.isDirectory()) throw new Error('unexpected entry in instance templates directory');
        const config = JSON.parse(readFileSync(join(templatesDir, instance.name, team.name, 'template.json'), 'utf8'));
        if (!config || typeof config !== 'object' || typeof config.name !== 'string') throw new Error('invalid agent template');
        snapshot.templates.push({ instanceId: instance.name, teamId: team.name, config });
      }
    }
  }
  const ids = snapshot.identities.map(b => JSON.stringify([b.instanceId, b.providerId, b.externalSubject]));
  if (new Set(ids).size !== ids.length) throw new Error('duplicate identity records');
  return snapshot;
}

/** A dedicated connection is required so all statements share one transaction. */
export async function importPanelSnapshot(sql: PanelSql, snapshot: PanelSnapshot): Promise<void> {
  await sql.query('BEGIN');
  try {
    await sql.query(PANEL_SCHEMA_SQL);
    await sql.query('LOCK TABLE panel_identities, panel_agent_templates IN ACCESS EXCLUSIVE MODE');
    const result = await sql.query('SELECT (SELECT count(*) FROM panel_identities)+(SELECT count(*) FROM panel_agent_templates) AS count');
    if (Number(result.rows[0]?.count) !== 0) throw new Error('Panel target must be empty; refusing to overwrite');
    const store = new PostgresPanelStore(sql);
    for (const binding of snapshot.identities) await store.identities.save(binding);
    for (const template of snapshot.templates) await store.templates.save(template.instanceId, template.teamId, template.config);
    const counts = await sql.query('SELECT (SELECT count(*) FROM panel_identities)+(SELECT count(*) FROM panel_agent_templates) AS count');
    if (Number(counts.rows[0]?.count) !== snapshot.identities.length + snapshot.templates.length) throw new Error('Panel import verification failed');
    await sql.query('COMMIT');
  } catch (err) {
    await sql.query('ROLLBACK');
    throw err;
  }
}
