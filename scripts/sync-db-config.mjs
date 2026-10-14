import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('config/db-loader.ts', root), 'utf8');
for (const module of ['MemoryCore', 'MemoryKnowledge', 'MemoryPanel', 'MemoryProxy']) {
  const file = new URL(`${module}/src/db-config.ts`, root);
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== source) throw new Error(`Run node scripts/sync-db-config.mjs: ${fileURLToPath(file)}`);
  } else writeFileSync(file, source);
}
