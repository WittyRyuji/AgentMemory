// Run after installing MemoryProxy dependencies; no Docker daemon or real secrets needed.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../MemoryProxy/package.json', import.meta.url));
const { load } = require('js-yaml');
const root = new URL('../', import.meta.url);
const names = new Set();
for (const component of ['postgres', 'core', 'panel', 'proxy', 'knowledge']) {
  const doc = load(readFileSync(new URL(`docker-compose.${component}.yaml`, root), 'utf8'));
  assert.deepEqual(Object.keys(doc.services), [component]);
  assert(!names.has(doc.name)); names.add(doc.name);
  assert.equal(doc.name, `agentmemory-${component}`);
  assert.equal(doc.networks.shared.external, true);
  assert.equal(doc.networks.shared.name, '${AGENTMEMORY_NETWORK:-agentmemory}');
  const service = doc.services[component];
  assert.equal(service.environment.POSTGRES_PASSWORD, "${POSTGRES_PASSWORD:?Set a PostgreSQL password outside Git}");
  assert(!service.depends_on && !service.profiles && !service.container_name);
  assert.deepEqual(service.networks.shared.aliases, [component]);
  for (const port of service.ports ?? []) assert(port.startsWith('127.0.0.1:'));
  if (component === 'postgres') {
    assert(!service.ports);
    assert.equal(doc.volumes['agentmemory-postgres'].external, true);
    assert(doc.volumes['agentmemory-postgres'].name.startsWith('${POSTGRES_VOLUME:?'));
  } else {
    const config = service.volumes.find(v => v.target === '/app/config/db.toml');
    assert.equal(config.source, './config/db.toml');
    assert.equal(service.environment.AGENTMEMORY_DB_CONFIG, config.target);
    for (const mount of service.volumes.filter(v => v.type === 'bind')) {
      assert.equal(mount.read_only, true);
      assert.equal(mount.bind.create_host_path, false);
    }
    const context = typeof service.build === 'string' ? service.build : service.build.context;
    const dockerfile = service.build.dockerfile ?? 'Dockerfile';
    assert(existsSync(new URL(`${context}/${dockerfile}`, root)));
  }
}
const core = load(readFileSync(new URL('docker-compose.core.yaml', root), 'utf8'));
assert.equal(core.services.core.environment.MEMORY_EMBEDDING_ENDPOINT, '${MEMORY_EMBEDDING_ENDPOINT:-}');
assert.equal(core.services.core.environment.MEMORY_EMBEDDING_BASE_URL, '${MEMORY_EMBEDDING_BASE_URL:-}');
assert.equal(core.services.core.environment.MEMORY_EMBEDDING_FORMAT, '${MEMORY_EMBEDDING_FORMAT:-openai}');
const gateway = load(readFileSync(new URL('MemoryCore/tdai-gateway.postgres.yaml', root), 'utf8'));
assert.equal(gateway.memory.embedding.endpoint, '${MEMORY_EMBEDDING_ENDPOINT}');
assert.equal(gateway.memory.embedding.format, '${MEMORY_EMBEDDING_FORMAT}');
assert.equal(gateway.memory.embedding.baseUrl, '${MEMORY_EMBEDDING_BASE_URL}');
const proxy = load(readFileSync(new URL('MemoryProxy/config.postgres.example.yaml', root), 'utf8'));
assert.equal(proxy.storage.backend, 'postgres');
assert.equal(proxy.auth.enabled, true);
assert.equal(proxy.auth.url, 'http://core:8420');
assert.equal(proxy.redis.enabled, false);
assert.equal(proxy.injection.enabled, true);
assert.equal(proxy.creditReport.url, '');
const panelIgnore = readFileSync(new URL('MemoryPanel/docker/local/Dockerfile.local.dockerignore', root), 'utf8');
assert(panelIgnore.split('\n').includes('config/db.toml'));
console.log('PASS: five isolated single-service Compose files, shared DNS, loopback ports, safe mounts and PG volume');
