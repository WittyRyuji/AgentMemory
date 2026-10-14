#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# PostgreSQL runtime: no local SQLite native compilation is needed.
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22 || major===22 && minor>=13 ? 0 : 1)'; then
  echo "Node.js 22.13+ is required" >&2
  exit 1
fi
if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi
node --input-type=module -e 'import "dotenv/config"; if (!(process.env.KNOWLEDGE_POSTGRES_URL || process.env.DATABASE_URL)) { console.error("KNOWLEDGE_POSTGRES_URL is required"); process.exit(1); }'
echo "Starting Knowledge (PostgreSQL), port ${PORT:-8421}"
exec npm run dev
