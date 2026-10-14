import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgresPanelStore, type PanelSql } from '../src/panel/state/postgres-store.js';
import { importPanelSnapshot, readPanelSnapshot } from '../src/panel/state/import-postgres.js';
import { FileIdentityStore, encryptSecret, decryptSecret } from '../src/panel/auth/identity-store.js';
import { FileAgentTemplateStore } from '../src/panel/state/agent-template-store.js';
import { loadPanelConfig } from '../src/panel/config/panel-config.js';

const schema = `panel_test_${randomUUID().replaceAll('-', '')}`;
let embedded: PGlite | undefined;
let native: Client | undefined;
let sql: PanelSql;
let store: PostgresPanelStore;
const secret = 'synthetic-test-secret';
const binding = { instanceId: 'tenant-a', providerId: 'woa', externalSubject: 'subject', coreUserId: 'user-1', encryptedUserKey: encryptSecret('test-key', secret), updatedAt: '2026-01-01T00:00:00.000Z' };

beforeAll(async () => {
  if (process.env.PG_TEST_URL) {
    if (!new URL(process.env.PG_TEST_URL).pathname.endsWith('_test')) throw new Error('PG_TEST_URL must use a disposable *_test database');
    native = new Client({ connectionString: process.env.PG_TEST_URL });
    await native.connect();
    await native.query(`CREATE SCHEMA ${schema}`);
    await native.query(`SET search_path TO ${schema}`);
    sql = native;
  } else {
    embedded = new PGlite();
    sql = { query: async (query, values = []) => {
      if (query.includes(';') && !values.length) { const r = (await embedded!.exec(query)).at(-1); return { rows: r?.rows as Record<string, unknown>[] ?? [] }; }
      return embedded!.query(query, values);
    } };
  }
  store = new PostgresPanelStore(sql);
  await store.initialize();
}, 60_000);
afterAll(async () => {
  if (native) { await native.query(`DROP SCHEMA ${schema} CASCADE`); await native.end(); }
  await embedded?.close();
});

describe('Panel PostgreSQL state', () => {
  it('keeps identity encryption and tenant/provider keys across store instances', async () => {
    await store.identities.save(binding);
    const restarted = new PostgresPanelStore(sql);
    const found = await restarted.identities.find('tenant-a', 'woa', 'subject');
    expect(decryptSecret(found!.encryptedUserKey, secret)).toBe('test-key');
    expect(await restarted.identities.find('tenant-b', 'woa', 'subject')).toBeNull();
    expect(await restarted.identities.find('tenant-a', 'other', 'subject')).toBeNull();
    await restarted.identities.save({ ...binding, displayName: 'updated' });
    expect((await store.identities.find('tenant-a', 'woa', 'subject'))?.displayName).toBe('updated');
  });
  it('round-trips full templates, scoped by instance and team, with overwrite', async () => {
    const template = { name: 'Agent', prompt: '你好', description: null, metadata_json: '{"x":1}', asset_ids: { skills: ['s1'], wikis: ['w1'], code_graphs: ['c1'] } };
    await store.templates.save('tenant-a', 'team', template);
    expect(await new PostgresPanelStore(sql).templates.get('tenant-a', 'team')).toEqual(template);
    expect(await store.templates.get('tenant-b', 'team')).toBeNull();
    await store.templates.save('tenant-a', 'team', { name: 'changed' });
    expect(await store.templates.get('tenant-a', 'team')).toEqual({ name: 'changed' });
  });
  it('never interprets database errors as missing data or a successful write', async () => {
    const broken = new PostgresPanelStore({ query: async () => { throw new Error('offline'); } });
    await expect(broken.initialize()).rejects.toThrow('offline');
    await expect(broken.identities.find('i', 'p', 's')).rejects.toThrow('offline');
    await expect(broken.identities.save(binding)).rejects.toThrow('offline');
    await expect(broken.templates.get('i', 't')).rejects.toThrow('offline');
    await expect(broken.templates.save('i', 't', { name: 'x' })).rejects.toThrow('offline');
  });
  it('imports a file snapshot atomically and refuses nonempty targets', async () => {
    await sql.query('TRUNCATE panel_identities, panel_agent_templates');
    const snapshot = { identities: [binding], templates: [{ instanceId: 'i', teamId: 't', config: { name: 'Migrated', asset_ids: { skills: ['s'] } } }] };
    await importPanelSnapshot(sql, snapshot);
    expect(await store.identities.find('tenant-a', 'woa', 'subject')).toEqual(binding);
    expect(await store.templates.get('i', 't')).toEqual(snapshot.templates[0]!.config);
    await expect(importPanelSnapshot(sql, snapshot)).rejects.toThrow('empty');
    expect(await store.templates.get('i', 't')).toEqual(snapshot.templates[0]!.config);
    await sql.query('TRUNCATE panel_identities, panel_agent_templates');
    await expect(importPanelSnapshot(sql, { identities: [binding], templates: [{ instanceId: 'i', teamId: null as unknown as string, config: { name: 'bad' } }] })).rejects.toThrow();
    expect(await store.identities.find('tenant-a', 'woa', 'subject')).toBeNull();
  });
  it('preserves file modes and source bytes during dry-run snapshot scanning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-pg-'));
    try {
      const identityFile = join(dir, 'identities.json');
      const templates = join(dir, 'templates');
      const file = new FileIdentityStore(identityFile);
      file.save(binding);
      const template = new FileAgentTemplateStore(templates);
      template.save('i', 't', { name: 'Legacy' });
      const before = readFileSync(identityFile, 'utf8');
      expect(readPanelSnapshot(identityFile, templates)).toEqual({ identities: [binding], templates: [{ instanceId: 'i', teamId: 't', config: { name: 'Legacy' } }] });
      expect(readFileSync(identityFile, 'utf8')).toBe(before);
      expect(new FileIdentityStore(identityFile).find('tenant-a', 'woa', 'subject')).toEqual(binding);
      expect(template.get('missing', 't')).toBeNull();
      writeFileSync(identityFile, '{bad');
      expect(() => readPanelSnapshot(identityFile)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires an explicit valid backend and URL', () => {
    const old = { mode: process.env.PANEL_STATE_BACKEND, url: process.env.PANEL_POSTGRES_URL, db: process.env.DATABASE_URL };
    try {
      process.env.PANEL_STATE_BACKEND = 'postgres'; delete process.env.PANEL_POSTGRES_URL; delete process.env.DATABASE_URL;
      expect(() => loadPanelConfig()).toThrow('required');
      process.env.DATABASE_URL = 'postgresql://example.invalid/db';
      expect(loadPanelConfig().state?.backend).toBe('postgres');
      process.env.PANEL_STATE_BACKEND = 'bogus';
      expect(() => loadPanelConfig()).toThrow('invalid');
    } finally {
      for (const [key, value] of Object.entries({ PANEL_STATE_BACKEND: old.mode, PANEL_POSTGRES_URL: old.url, DATABASE_URL: old.db })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});
