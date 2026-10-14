import { loadDatabaseConfig } from '../src/db-config.js';
import { Pool } from 'pg';
import { readPanelSnapshot, importPanelSnapshot } from '../src/panel/state/import-postgres.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('migrate:postgres --identities FILE --templates DIR [--apply]\nSources are optional individually. Stop Panel writers and back up sources first. Default: read-only dry run.\n--apply requires PANEL_POSTGRES_URL or DATABASE_URL and an empty Panel target. Preserve the original session secret file.');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') continue;
    if (!['--identities', '--templates'].includes(args[i]!) || !args[++i] || args[i]!.startsWith('--')) throw new Error('invalid migration arguments; use --help');
  }
  if (!value('--identities') && !value('--templates')) throw new Error('provide --identities and/or --templates');
  const snapshot = readPanelSnapshot(value('--identities'), value('--templates'));
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', identities: snapshot.identities.length, templates: snapshot.templates.length }));
  if (!args.includes('--apply')) return;
  const connectionString = loadDatabaseConfig('panel').url;
  if (!connectionString) throw new Error('PANEL_POSTGRES_URL or DATABASE_URL is required');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    const client = await pool.connect();
    try { await importPanelSnapshot(client, snapshot); } finally { client.release(); }
    console.log('Panel import verified and committed. Source files are unchanged.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Panel migration failed; check sources, empty target, and PostgreSQL access. No source files were changed.'); process.exitCode = 1; });
