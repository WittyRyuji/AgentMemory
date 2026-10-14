import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PostgresRateLimitStore } from '../../rate-limit/postgres-store.js';
import { PostgresStorage, type ProxySql } from '../postgres-storage.js';
import { allocatePostgresTurnSeq } from '../postgres-turn-seq.js';
import { importProxySnapshot, readProxySnapshot, readRateLimitSnapshot } from '../import-postgres.js';
import { KvBindingRepo } from '../../db/kv-binding-repo.js';
import { KvSessionRepo } from '../../db/kv-session-repo.js';
import { KvVersionPinRepo } from '../../skill/kv-version-pin-repo.js';
import { SessionStore } from '../../session/store.js';
import { getProxyStorage, __resetProxyStorageForTests } from '../factory.js';
import { buildConfig, DEFAULT_CONFIG } from '../../config.js';
import type { SessionInitState } from '../../session/types.js';

const schema = `proxy_test_${randomUUID().replaceAll('-', '')}`;
let embedded: PGlite | undefined;
let native: Client | undefined;
let sql: ProxySql;
let storage: PostgresStorage;
beforeAll(async () => {
  if (process.env.PG_TEST_URL) {
    if (!new URL(process.env.PG_TEST_URL).pathname.endsWith('_test')) throw new Error('PG_TEST_URL must use a disposable *_test database');
    native = new Client({ connectionString: process.env.PG_TEST_URL }); await native.connect();
    await native.query(`CREATE SCHEMA ${schema}`); await native.query(`SET search_path TO ${schema}`); sql = native;
  } else {
    embedded = new PGlite();
    sql = { query: async (query, values = []) => {
      if (query.includes(';') && !values.length) { const r = (await embedded!.exec(query)).at(-1); return { rows: r?.rows as Record<string, unknown>[] ?? [] }; }
      return embedded!.query(query, values);
    } };
  }
  storage = new PostgresStorage(sql); await storage.initialize();
}, 60_000);
afterAll(async () => {
  if (native) { await native.query(`DROP SCHEMA ${schema} CASCADE`); await native.end(); }
  await embedded?.close();
});

describe('Proxy PostgreSQL storage', () => {
  it('round-trips text/JSON across instances and scopes literal prefixes', async () => {
    await storage.putJSON('nottl/a%_/state.json', { value: '你好' });
    await storage.putText('nottl/aXX/state.json', 'other');
    const restarted = new PostgresStorage(sql);
    expect(await restarted.getJSON('nottl/a%_/state.json')).toEqual({ value: '你好' });
    expect(await restarted.listNames('nottl/a%_/')).toEqual(['state.json']);
    expect(await restarted.delPrefix('nottl/a%_/')).toBe(1);
    expect(await restarted.exists('nottl/aXX/state.json')).toBe(true);
    expect(await restarted.getText('nottl/missing')).toBeNull();
    await expect(storage.putText('../escape', 'bad')).rejects.toThrow('invalid');
  });
  it('makes put-if-absent a database atomic CAS', async () => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => new PostgresStorage(sql).putTextIfAbsent('nottl/cas', String(i))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storage.getText('nottl/cas')).toBe('0');
  });
  it('expires only ttl rows while keeping permanent business state', async () => {
    await storage.putText('ttl/old', 'expire'); await storage.putText('nottl/old', 'keep');
    await sql.query('UPDATE proxy_kv SET updated_at=1 WHERE k=$1 OR k=$2', ['ttl/old', 'nottl/old']);
    expect(await storage.sweep({ ttlMs: 10, now: 100 })).toEqual({ removedTtl: 1 });
    expect(await storage.getText('ttl/old')).toBeNull(); expect(await storage.getText('nottl/old')).toBe('keep');
  });
  it('preserves complete session bindings and creation timestamps across updates', async () => {
    const repo = new KvBindingRepo(storage);
    await repo.putBinding('space', 'session', { outcome: 'initialized', userId: 'u', teamId: 't', agentId: 'a', taskId: 'task', agentSource: 'claude-code', userKey: 'synthetic' });
    const key = 'nottl/space/session/binding.json';
    const first = await storage.getJSON<Record<string, unknown>>(key);
    await new KvBindingRepo(new PostgresStorage(sql)).putBinding('space', 'session', { outcome: 'bypassed', userId: 'u' });
    await repo.touchLastSeen('space', 'session');
    expect((await storage.getJSON<Record<string, unknown>>(key))?.created_at).toBe(first?.created_at);
    expect((await repo.getBinding('space', 'session'))?.outcome).toBe('bypassed');
    expect(await repo.getBinding('different', 'session')).toBeNull();
    await repo.deleteBinding('space', 'session'); expect(await repo.getBinding('space', 'session')).toBeNull();
  });
  it('keeps session states and skill-version CAS behavior', async () => {
    const repo = new KvSessionRepo(storage);
    const state = { keyId: 'key', status: 'pending_asset_confirm', startedAt: Date.now(), attemptCount: 1 } as SessionInitState;
    await repo.upsert('space', 'u', 'claude-code', 's', state);
    expect(await new KvSessionRepo(new PostgresStorage(sql)).getBySessionId('space', 'u', 'claude-code', 's')).toEqual(state);
    expect(await repo.getBySessionId('other', 'u', 'claude-code', 's')).toBeNull();
    const pins = new KvVersionPinRepo(storage);
    await pins.pinMany('space', 'u', 'claude-code', 's', [{ skillId: 'skill', version: 1 }]);
    await pins.pinMany('space', 'u', 'claude-code', 's', [{ skillId: 'skill', version: 2 }]);
    expect(await pins.getVersion('space', 'u', 'claude-code', 's', 'skill')).toBe(1);
    await pins.upsertVersion('space', 'u', 'claude-code', 's', 'skill', 3);
    expect(await pins.getVersion('space', 'u', 'claude-code', 's', 'skill')).toBe(3);
  });
  it('propagates authoritative PG failures through session and binding layers', async () => {
    const broken = new PostgresStorage({ query: async () => { throw new Error('offline'); } });
    const sessions = new KvSessionRepo(broken), bindings = new KvBindingRepo(broken);
    await expect(bindings.getBinding('s', 'id')).rejects.toThrow('offline');
    await expect(bindings.putBinding('s', 'id', { outcome: 'bypassed' })).rejects.toThrow('offline');
    await expect(bindings.deleteBinding('s', 'id')).rejects.toThrow('offline');
    await expect(sessions.getBySessionId('s', 'u', 'claude-code', 'id')).rejects.toThrow('offline');
    await expect(sessions.deleteBySessionId('s', 'u', 'claude-code', 'id')).rejects.toThrow('offline');
    const store = new SessionStore(60_000, sessions, bindings);
    store.bind('key', { spaceId: 's', userId: 'u', agentSource: 'claude-code', sessionId: 'id' });
    await expect(store.set('key', { keyId: 'key', status: 'initialized', startedAt: Date.now(), attemptCount: 0 } as SessionInitState)).rejects.toThrow('offline');
    expect(store.get('key')).toBeUndefined();
  });
  it('does not resurrect locally cached state after authoritative deletion', async () => {
    const sessions = new KvSessionRepo(storage), bindings = new KvBindingRepo(storage);
    const store = new SessionStore(60_000, sessions, bindings);
    const identity = { spaceId: 'gone', userId: 'u', agentSource: 'claude-code', sessionId: 's' };
    store.bind('gone-key', identity);
    await store.set('gone-key', { keyId: 'gone-key', status: 'pending_asset_confirm', startedAt: Date.now(), attemptCount: 0 } as SessionInitState);
    await sessions.deleteBySessionId('gone', 'u', 'claude-code', 's');
    expect(await store.getOrRecover('gone-key', identity, {})).toBeUndefined();
    expect(store.get('gone-key')).toBeUndefined();
  });
  it('requires async PostgreSQL activation and explicit URL instead of local fallback', () => {
    __resetProxyStorageForTests();
    expect(() => getProxyStorage({ ...DEFAULT_CONFIG.storage, backend: 'postgres' })).toThrow('no fallback');
    const old = { backend: process.env.PROXY_STORAGE_BACKEND, url: process.env.PROXY_POSTGRES_URL, db: process.env.DATABASE_URL };
    try {
      process.env.PROXY_STORAGE_BACKEND = 'postgres'; delete process.env.PROXY_POSTGRES_URL; delete process.env.DATABASE_URL;
      expect(() => buildConfig({ configFile: '/tmp/nonexistent-proxy-config.yaml' })).toThrow('required');
      process.env.DATABASE_URL = 'postgresql://example.invalid/db';
      const config = buildConfig({ configFile: '/tmp/nonexistent-proxy-config.yaml' });
      expect(config.storage.enabled).toBe(true); expect(config.storage.backend).toBe('postgres');
    } finally {
      for (const [k, v] of Object.entries({ PROXY_STORAGE_BACKEND: old.backend, PROXY_POSTGRES_URL: old.url, DATABASE_URL: old.db })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  it('preserves admin rate limits and atomically enforces request/token windows without Redis', async () => {
    const rate = new PostgresRateLimitStore(storage, { tpm: 100, qpm: 2 });
    await rate.setLimits({ qpm: 3 });
    await rate.setLimits({ tpm: 200 });
    expect(await rate.getLimits()).toEqual({ tpm: 200, qpm: 3 });
    await rate.setOverride('tenant', 'model', { tpm: 10, qpm: 2 });
    expect(await new PostgresRateLimitStore(new PostgresStorage(sql), { tpm: 100, qpm: 2 }).getOverride('tenant', 'model')).toEqual({ tpm: 10, qpm: 2 });
    const decisions = await Promise.all(Array.from({ length: 8 }, () => rate.checkRequest('tenant', 'model')));
    expect(decisions.filter(d => d.allowed)).toHaveLength(2);
    expect(decisions.filter(d => !d.allowed).every(d => d.reason === 'qpm' && d.retryAfterSeconds > 0)).toBe(true);
    expect((await rate.checkRequest('other', 'model')).allowed).toBe(true);
    await rate.recordInputTokens('tokens', 'model', 200);
    const decision = await rate.checkRequest('tokens', 'model');
    expect(decision.allowed).toBe(false); expect(decision.reason).toBe('tpm');
    await sql.query("UPDATE proxy_rate_limit_windows SET buckets='{}' WHERE dimension=$1", [JSON.stringify(['tokens', 'model'])]);
    expect((await rate.checkRequest('tokens', 'model')).allowed).toBe(true);
    expect(await rate.listOverrides()).toContainEqual({ instanceId: 'tenant', modelId: 'model', tpm: 10, qpm: 2 });
    await rate.deleteOverride('tenant', 'model'); expect(await rate.getOverride('tenant', 'model')).toBeNull();
    await rate.deleteLimits(); expect(await rate.getLimits()).toEqual({ tpm: 100, qpm: 2 });
    const broken = new PostgresRateLimitStore(new PostgresStorage({ query: async () => { throw new Error('offline'); } }), { tpm: 100, qpm: 2 });
    await expect(broken.checkRequest('tenant', 'model')).rejects.toThrow('offline');
  });
  it('keeps turn sequences monotonic across compaction, lanes and store instances', async () => {
    expect(await allocatePostgresTurnSeq(storage, 'session-key', 'main', 8, 100)).toBe(8);
    expect(await allocatePostgresTurnSeq(new PostgresStorage(sql), 'session-key', 'main', 8, 100)).toBe(8);
    expect(await allocatePostgresTurnSeq(storage, 'session-key', 'main', 1, 100)).toBe(9);
    expect(await allocatePostgresTurnSeq(storage, 'session-key', 'fork', 1, 100)).toBe(10);
    expect(await allocatePostgresTurnSeq(storage, 'session-key', 'main', 1, 100)).toBe(9);
    const next = await Promise.all(Array.from({ length: 8 }, () => allocatePostgresTurnSeq(storage, 'session-key', 'main', 2, 100)));
    expect(new Set(next)).toEqual(new Set([11]));
    await sql.query('UPDATE proxy_turn_sequences SET expires_at=0');
    expect(await allocatePostgresTurnSeq(storage, 'session-key', 'main', 1, 100)).toBe(1);
  });
  it('imports atomically, verifies counts, and refuses overwriting an existing target', async () => {
    await sql.query('TRUNCATE proxy_kv');
    const rows = [{ key: 'nottl/import', value: '{"ok":true}', updatedAt: 123 }];
    await importProxySnapshot(sql, rows);
    expect(await storage.getJSON('nottl/import')).toEqual({ ok: true });
    expect(Number((await sql.query('SELECT updated_at FROM proxy_kv WHERE k=$1', ['nottl/import'])).rows[0]?.updated_at)).toBe(123);
    await expect(importProxySnapshot(sql, rows)).rejects.toThrow('empty');
    await sql.query('TRUNCATE proxy_kv');
    await expect(importProxySnapshot(sql, [rows[0]!, rows[0]!])).rejects.toThrow();
    expect(await storage.getText('nottl/import')).toBeNull();
  });
  it('scans filesystem and legacy SQLite without modifying source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-pg-'));
    try {
      mkdirSync(join(dir, 'state/nottl/sp/s'), { recursive: true });
      const exportFile = join(dir, 'limits.json');
      writeFileSync(exportFile, JSON.stringify({ code: 0, data: { tpm: 100, qpm: 10, overrides: [{ instanceId: 'i', modelId: 'm', tpm: 50, qpm: 2 }] } }));
      expect(readRateLimitSnapshot(exportFile)).toHaveLength(2);
      const file = join(dir, 'state/nottl/sp/s/binding.json');
      writeFileSync(file, '{"outcome":"bypassed"}');
      expect(readProxySnapshot(join(dir, 'state'))[0]?.value).toBe(readFileSync(file, 'utf8'));
      // Isolate the native SQLite addon from PGlite/Vitest's WASM VM lifecycle.
      const database = join(dir, 'legacy.sqlite');
      execFileSync(process.execPath, ['-e', `
        const Database=require('better-sqlite3'); const db=new Database(process.argv[1]);
        db.exec('CREATE TABLE sessions(session_id TEXT,state_json TEXT,created_at INTEGER,updated_at INTEGER)');
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('space:u:claude-code:session', JSON.stringify({status:'initialized',sessionInfo:{user_id:'u',team_id:'t',agent_id:'a'}}),10,20);
        db.close();`, database]);
      const before = readFileSync(database);
      const importer = new URL('../import-postgres.ts', import.meta.url).href;
      const rows = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
        `import {readProxySnapshot} from ${JSON.stringify(importer)}; console.log(JSON.stringify(readProxySnapshot(undefined,process.argv[1])));`, database], { encoding: 'utf8' })) as Array<{key:string;value:string}>;
      expect(rows.map(r => r.key).sort()).toEqual(['nottl/space/session/binding.json', 'ttl/space/u/claude-code/session/inj-sess.json']);
      expect(JSON.parse(rows.find(r => r.key.endsWith('binding.json'))!.value).agentId).toBe('a');
      expect(readFileSync(database)).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
