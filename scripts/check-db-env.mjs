// Node 22.18+; run after installing dependencies in the module under test.
// All credentials are synthetic. No database or network is used.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const modules = process.argv.slice(2);
for (const name of modules.length ? modules : ['MemoryCore', 'MemoryKnowledge', 'MemoryPanel', 'MemoryProxy']) {
  assert(['MemoryCore', 'MemoryKnowledge', 'MemoryPanel', 'MemoryProxy'].includes(name));
  const { loadDatabaseConfig, databaseBackend } = await import(`../${name}/src/db-config.ts`);
  const cwd = mkdtempSync(join(tmpdir(), 'db-env-test-'));
  mkdirSync(join(cwd, 'config'));
  const write = text => writeFileSync(join(cwd, 'config/db.toml'), text);
  const template = '[postgres]\nurl = "postgresql://agentmemory@postgres:5432/agentmemory"\npassword_env = "POSTGRES_PASSWORD"';
  const raw = ' synthetic:@/#%$ \\"密碼';
  try {
    write(template);
    for (const module of ['core', 'knowledge', 'panel', 'proxy']) {
      const result = loadDatabaseConfig(module, { POSTGRES_PASSWORD: raw }, cwd);
      assert.equal(decodeURIComponent(new URL(result.url).password), raw);
      assert.equal(new URL(result.url).hostname, 'postgres');
      assert.equal(databaseBackend(result, undefined, 'sqlite'), 'postgres');
      if (module === 'core') assert.equal(result.metadataUrl, result.url);
    }
    for (const password of [undefined, '', '  ']) {
      for (const override of [undefined, 'env']) {
        assert.throws(() => loadDatabaseConfig('core', {POSTGRES_PASSWORD: password, AGENTMEMORY_DB_OVERRIDE: override, DATABASE_URL:'postgresql://other/db'}, cwd), /missing or empty/);
      }
    }
    assert.throws(() => loadDatabaseConfig('core', {POSTGRES_PASSWORD:raw,DATABASE_URL:'postgresql://other/db'}, cwd), /conflict/);
    assert.equal(loadDatabaseConfig('core', {POSTGRES_PASSWORD:raw,AGENTMEMORY_DB_OVERRIDE:'env',DATABASE_URL:'postgresql://other/db'}, cwd).url, 'postgresql://other/db');
    write(template + '\n[panel]\nurl_env = "PANEL_URL"\n[core]\nmetadata_url_env = "META_URL"');
    assert.equal(loadDatabaseConfig('panel', {PANEL_URL:'postgresql://panel/db'}, cwd).url, 'postgresql://panel/db');
    assert.equal(loadDatabaseConfig('core', {POSTGRES_PASSWORD:raw,META_URL:'postgresql://meta/db'}, cwd).metadataUrl, 'postgresql://meta/db');
    assert.throws(() => loadDatabaseConfig('core', {POSTGRES_PASSWORD:raw}, cwd), /missing or empty/);
    write('[postgres]\nurl_env = "DB_URL"');
    assert.equal(loadDatabaseConfig('proxy', {DB_URL:'postgresql://test:p%40ss@db/data'}, cwd).url, 'postgresql://test:p%40ss@db/data');
    assert.throws(() => loadDatabaseConfig('proxy', {DB_URL:'synthetic-secret'}, cwd), /redacted/);
    for (const text of [
      template + '\nurl_env = "DB_URL"',
      '[postgres]\npassword_env = "POSTGRES_PASSWORD"',
      template.replace('POSTGRES_PASSWORD', '${SECRET}'),
      template.replace('agentmemory@', 'agentmemory:synthetic-secret@'),
      template.replace('agentmemory@', ''),
      '[core]\nmetadata_url="postgresql://db/data"\nmetadata_url_env="META"',
    ]) {
      write(text);
      assert.throws(() => loadDatabaseConfig('core', {POSTGRES_PASSWORD:raw}, cwd), err => !String(err).includes(raw) && !String(err).includes('synthetic-secret'));
    }
    write('[postgres]\nurl="postgresql://test:legacy@db/data"');
    assert.equal(loadDatabaseConfig('core', {}, cwd).url, 'postgresql://test:legacy@db/data');
    write(readFileSync(new URL('../config/db.example.toml', import.meta.url), 'utf8'));
    assert.equal(decodeURIComponent(new URL(loadDatabaseConfig('core', {POSTGRES_PASSWORD:raw}, cwd).url).password), raw);
    writeFileSync(join(cwd, '.env'), "POSTGRES_PASSWORD='synthetic:$@/#%密碼'\n");
    const entry = new URL(`../${name}/src/db-config.ts`, import.meta.url).href;
    const output = execFileSync(process.execPath, [`--env-file=${join(cwd, '.env')}`, '--input-type=module', '-e',
      `import {loadDatabaseConfig} from ${JSON.stringify(entry)}; const c=loadDatabaseConfig('core'); if(decodeURIComponent(new URL(c.url).password)!=='synthetic:$@/#%密碼')process.exit(1); console.log('ok');`
    ], {cwd, env: {}, encoding:'utf8'});
    assert.equal(output.trim(), 'ok');
    console.log(`PASS ${name}: environment references, raw-password encoding, fail-closed, precedence, redaction and legacy support`);
  } finally { rmSync(cwd, {recursive:true, force:true}); }
}
