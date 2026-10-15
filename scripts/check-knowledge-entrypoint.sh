#!/usr/bin/env bash
# Stub Node: validate entrypoint handoff only, without database/provider calls.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
printf '#!/bin/sh\nprintf "NODE_HANDOFF_OK\\n"\n' > "$tmp/bin/node"
chmod +x "$tmp/bin/node"
printf '[postgres]\nurl = "postgresql://fixture:fixture@postgres/fixture"\n' > "$tmp/db.toml"
run() {
  env -i PATH="$tmp/bin:$PATH" KNOWLEDGE_PUBLIC_BASE_URL=http://localhost:8421/v3 \
    KNOWLEDGE_DATA_DIR="$tmp/data" "$@" bash MemoryKnowledge/docker/entrypoint.sh --code-graph-only
}
run AGENTMEMORY_DB_CONFIG="$tmp/db.toml" > "$tmp/out" 2>&1
grep -q NODE_HANDOFF_OK "$tmp/out"
run AGENTMEMORY_DB_CONFIG="$tmp/missing.toml" KNOWLEDGE_POSTGRES_URL=postgresql://fixture > "$tmp/out" 2>&1
grep -q NODE_HANDOFF_OK "$tmp/out"
if run AGENTMEMORY_DB_CONFIG="$tmp/missing.toml" > "$tmp/out" 2>&1; then
  echo 'FAIL: missing database configuration accepted' >&2; exit 1
fi
if grep -q NODE_HANDOFF_OK "$tmp/out"; then exit 1; fi
echo 'PASS: Knowledge entrypoint accepts TOML / legacy URL and rejects absent configuration'
