import { loadDatabaseConfig } from '../src/db-config.js';
import { Pool } from 'pg';
import { readProxySnapshot, readRateLimitSnapshot, importProxySnapshot } from '../src/storage/import-postgres.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('migrate:postgres --fs-root DIR --sqlite FILE --rate-limits FILE [--apply]\nSources are optional individually. Stop all Proxy writers and back up sources first. Default: read-only dry run.\n--apply requires PROXY_POSTGRES_URL or DATABASE_URL and an empty proxy_kv target.');
    return;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') continue;
    if (!['--fs-root', '--sqlite', '--rate-limits'].includes(args[i]!) || !args[++i] || args[i]!.startsWith('--')) throw new Error('invalid migration arguments; use --help');
  }
  if (!value('--fs-root') && !value('--sqlite') && !value('--rate-limits')) throw new Error('provide --fs-root, --sqlite and/or --rate-limits');
  const rows = readProxySnapshot(value('--fs-root'), value('--sqlite'));
  if (value('--rate-limits')) rows.push(...readRateLimitSnapshot(value('--rate-limits')!));
  if (new Set(rows.map(r => r.key)).size !== rows.length) throw new Error('duplicate source keys; reconcile sources before importing');
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', rows: rows.length }));
  if (!args.includes('--apply')) return;
  const connectionString = loadDatabaseConfig('proxy').url;
  if (!connectionString) throw new Error('PROXY_POSTGRES_URL or DATABASE_URL is required');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    const client = await pool.connect();
    try { await importProxySnapshot(client, rows); } finally { client.release(); }
    console.log('Proxy import verified and committed. Source files are unchanged.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Proxy migration failed; check sources, empty target, and PostgreSQL access. No source files were changed.'); process.exitCode = 1; });
