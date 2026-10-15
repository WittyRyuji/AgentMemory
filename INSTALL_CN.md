# 当前 main：安装与使用指南

适用于 `WittyRyuji/AgentMemory` 的 `main`，包含 PostgreSQL / pgvector 和独立 OAuth。以下命令面向 Bash / 类 Unix 环境，除明确标注外均在仓库根目录执行。旧镜像路线见 [历史指南](INSTALL_LEGACY_CN.md)，不能用旧公共镜像替代当前源码构建。

## 1. 准备环境与代码

- Docker Engine + Compose v2：用于下面的最小容器安装。
- 原生源码启动：使用 **Node.js 22.18+ 的 22.x 系列**和 npm；Proxy 入口严格要求 22.x。CI 使用 Node 24 执行测试，并不代表 Proxy 入口支持 Node 24。
- PostgreSQL 17 + pgvector（Compose 提供）；已有数据库需允许应用创建 schema / 表，预先由管理员创建 `public.vector` 扩展。
- 一个可访问的 OpenAI-compatible **Embedding API**，知道 API Key、API 根地址、模型名和真实输出维数。只需要 API，不下载本地模型。

```sh
git clone --branch main --single-branch https://github.com/WittyRyuji/AgentMemory.git
cd AgentMemory
umask 077
cp config/db.example.toml config/db.toml
chmod 600 config/db.toml
```

已有安装先备份，勿覆盖现有配置。新安装按以下步骤；旧 SQLite / 文件 / Redis / COS 数据先阅读 [迁移说明](POSTGRES.md)，改连接串不会自动迁移。

## 2. 配置数据库

编辑根目录 `config/db.toml`。Compose 内服务使用 `postgres` 主机名：

```toml
[postgres]
url = "postgresql://agentmemory:REPLACE_WITH_DB_PASSWORD@postgres:5432/agentmemory"
```

下面 `.env` 的 `POSTGRES_PASSWORD` 必须与 URL 中的密码一致。URL 密码含 `@`、`:`、`/` 等保留字符时需百分号编码；`.env` 中仍写原始密码。TOML **不支持** `${VARIABLE}` 展开。原生运行使用数据库实际可达的地址，例如 `127.0.0.1:5432`。

四模块共同读取此文件；可用 `[core]`、`[knowledge]`、`[panel]`、`[proxy]` 的 `url` 分别覆盖。移除旧的冲突数据库环境变量和显式非 PG 后端设置，否则启动会拒绝。详见 [路径、优先级、TLS 与挂载规则](config/README.md)。

## 配置 Embedding

在**仓库根目录**新建 `.env`，复制下面占位模板并在本机填写真实值：

```dotenv
POSTGRES_PASSWORD=REPLACE_WITH_DB_PASSWORD
TDAI_GATEWAY_API_KEY=REPLACE_WITH_A_LONG_RANDOM_GATEWAY_KEY
TDAI_INSTANCE_ID=default
MEMORY_EMBEDDING_BASE_URL=https://embedding.example.com/v1
MEMORY_EMBEDDING_API_KEY=REPLACE_WITH_EMBEDDING_PROVIDER_KEY
MEMORY_EMBEDDING_MODEL=REPLACE_WITH_EMBEDDING_MODEL_ID
```

`embedding.example.com` 是占位地址，必须替换成提供商的真实 API 根地址。代码自动追加 `/embeddings`，不要把完整 `/v1/embeddings` 路径放在 `BASE_URL` 中。模型名必须是该服务支持的 Embedding 模型，不是聊天模型。

```sh
chmod 600 .env
```

`MemoryCore/tdai-gateway.postgres.yaml` 已包含：

```yaml
memory:
  embedding:
    enabled: true
    provider: openai
    baseUrl: "${MEMORY_EMBEDDING_BASE_URL}"
    apiKey: "${MEMORY_EMBEDDING_API_KEY}"
    model: "${MEMORY_EMBEDDING_MODEL}"
    dimensions: 1536
    sendDimensions: false
```

修改文件中已有的块，不要再添加第二个 `memory:`。`1536` 只是默认值，必须与实际输出一致；默认 `sendDimensions: false` 不会要求服务端降维。只有提供商支持请求体 `dimensions` 参数时才考虑启用。已有向量数据更换模型或维数需要规划重新向量化 / 迁移，不能直接混用。

密钥分工：

| 配置 | 用途 |
| --- | --- |
| `config/db.toml` | PostgreSQL 连接凭证 |
| `MEMORY_EMBEDDING_API_KEY` | 文本转向量 API；与 OAuth 独立 |
| `TDAI_GATEWAY_API_KEY` | 服务间访问 Core 的 Bearer 密钥 |
| `user_key` | Panel / Agent 用户身份，由 Core 创建 |
| `AGENTMEMORY_OAUTH_KEY` | OAuth vault 加密密钥，不是 API Key |

`.env` 和 `config/db.toml` 已被 Git 忽略；不要提交、截图、粘贴日志或把它们打包进镜像。不要把真值直接写入受版本管理的 YAML。含 `$` 等字符的 `.env` 值需遵循 Compose 的引号 / 插值规则；不要 `source` 不可信文件。避免将展开后的 `docker compose config` 输出分享给别人，其中可能包含密钥。

## 3. 启动 PostgreSQL + Core

```sh
docker compose --env-file .env -f docker-compose.postgres.yaml up -d --build postgres core
docker compose --env-file .env -f docker-compose.postgres.yaml ps
curl -fsS http://127.0.0.1:8420/health
```

Compose 会将 Embedding 三个变量传入 Core，并只读挂载数据库 TOML 和 Gateway YAML。数据库不映射宿主端口；Core 仅映射 `127.0.0.1:8420`。首次镜像构建需要下载依赖。

检查健康响应的存储和状态连接信息；`/health` 成功不等于外部 Embedding 或 LLM 调用成功。排错可在本机查看：

```sh
docker compose --env-file .env -f docker-compose.postgres.yaml logs --tail=100 core postgres
```

修改 `.env` 后重建容器使环境生效（仅 `restart` 不更新环境）：

```sh
docker compose --env-file .env -f docker-compose.postgres.yaml up -d --force-recreate core
```

停止且保留数据：

```sh
docker compose --env-file .env -f docker-compose.postgres.yaml down
```

不要在有用数据上使用 `down -v`，它会删除数据库卷。修改 `POSTGRES_PASSWORD` 不会更改已初始化数据库的密码；需按数据库管理流程修改实际角色密码及所有连接配置。

## 4. 最小写入 / 查询验证

在终端安全读入 Gateway Key，避免把真值写进命令历史：

```sh
read -rsp 'Gateway key: ' GATEWAY_KEY; printf '\n'
curl -fsS http://127.0.0.1:8420/capture \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"session_key":"install-check","user_content":"AgentMemory PostgreSQL 安装检查","assistant_content":"已记录安装检查。"}'
curl -fsS http://127.0.0.1:8420/search/conversations \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"PostgreSQL","session_key":"install-check"}'
unset GATEWAY_KEY
```

这是本机单实例的 L0 会话冒烟测试，会写入两条测试消息；不用于证明团队权限或 L1 提取成功。当前 YAML 关闭 `memory.extraction.enabled` 和 `skill.extraction.enabled`，所以不会自动生成 L1/L2/L3 / Skill。要启用这些能力，先完成下一节。

## 5. 可选：独立 OAuth 与 LLM 提取

[完整 OAuth 指南](OAUTH.md) 说明加密密钥、账号、vault、模型选择、远程回调和退出。概要：

1. 在安全环境中配置 `AGENTMEMORY_OAUTH_KEY`（32 字节随机值的标准 base64 编码）；保护并独立备份，不写入 YAML / TOML / Git。
2. 在能访问同一 PostgreSQL 且浏览器能到达 CLI 回环端口的机器上安装 Core 依赖，再由所有者运行登录：

   ```sh
   cd MemoryCore
   npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
   npm run oauth -- login --account owner --vault-id agentmemory
   npm run oauth -- status --account owner --vault-id agentmemory
   npm run oauth -- models --account owner --vault-id agentmemory
   ```

3. 所有者在浏览器确认 AgentMemory 自己的授权；使用 `models` 实际返回的模型 slug 设置 YAML `llm.provider: oauth` 及其 `oauth` 块，随后显式启用提取。
4. CLI 和 Core 必须使用同一数据库、加密密钥、account 和 vaultId。根 Compose **没有传入 OAuth 密钥**，需要通过受保护的 Compose override / secret 注入配置将命名环境变量传给 Core，并重新创建容器。

Compose 的 `postgres` 仅在容器网络可解析，数据库默认不对宿主发布。主机 CLI 不能直接照抄此连接串；应选择安全可达的同一数据库部署 / 网络方案。远程登录需要精确的 SSH 回环转发，不得公开 OAuth callback。

OAuth 不借用 Codex / Hermes / OpenClaw 会话，不提供 Embedding API，也不自动代替 Proxy 上游或 Knowledge Wiki LLM。配额、模型权限和账号资格由提供商决定；失败不会自动切换到付费 API Key 或本地模型。真实账号授权和推理尚未验证。

如选用原有 API-key LLM，按 [Gateway 配置样例](MemoryCore/tdai-gateway.standalone.yaml) 配置自己的 `llm` 块，再明确开启提取；这可能产生提供商费用，不能只填 Embedding Key。

## 6. 可选：Knowledge

最小 Compose profile 仅启用 CodeGraph：

```sh
# 先在根 .env 设置非空 KNOWLEDGE_SERVICE_KEY
# 调用方使用相同服务凭证；不要将未保护服务暴露到公网。
docker compose --env-file .env -f docker-compose.postgres.yaml --profile knowledge up -d --build
curl -fsS http://127.0.0.1:8421/health
```

默认命令为 `--code-graph-only`。Wiki 需要额外配置它自己的 LLM 路径及绑定，不能把 CodeGraph 健康当作 Wiki 已就绪。完整功能、迁移和持久化边界见 [Knowledge README](MemoryKnowledge/README.md) 和 [Knowledge PostgreSQL](MemoryKnowledge/POSTGRES.md)。

## 7. 可选：Panel 与 Proxy（独立源码服务）

根 Compose 不会启动这两个服务。以下以四模块都能访问同一**原生 / 外部 PostgreSQL**为前提：根 `config/db.toml` 使用对主机可达的数据库 URL。如果 Core / Knowledge 在容器内，主机与容器的数据库地址可能不同，应为每个运行环境用 `AGENTMEMORY_DB_CONFIG` 指向受保护、等价的配置，不要为了示例向公网开放数据库。

### Panel 管理界面

```sh
cd MemoryPanel
npm install
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
chmod 600 .env config/metadata-instances.json
```

编辑 Panel 的 `.env`：设置 `HOST=127.0.0.1`，把示例 `PANEL_STATE_BACKEND=file` **改为 `postgres`**，避免与共享 TOML 冲突。未部署 Knowledge 时设 `KNOWLEDGE_LLM_BINDING_SYNC=false`；部署时再填写其 URL 和 `KNOWLEDGE_AUTH_TOKEN`。

实例注册表只保留实际使用的实例，例如：

```json
{
  "instances": [{
    "id": "default",
    "name": "本地 AgentMemory",
    "gateway_endpoint": "http://127.0.0.1:8420",
    "proxy_endpoint": "http://127.0.0.1:8096",
    "api_key": "REPLACE_WITH_GATEWAY_KEY"
  }]
}
```

`id` 与 Core instance 一致；`api_key` 是服务间 Gateway Key，不是 Embedding Key。未启用 Proxy 时可省略 `proxy_endpoint`。

```sh
# 在 MemoryPanel 下，终端一：
npm run dev
# 在另一终端，从仓库根目录开始：
cd MemoryPanel/web
npm install
npm run dev -- --host 127.0.0.1
```

健康检查 `http://127.0.0.1:8123/health`，开发界面 `http://127.0.0.1:5173`。首次空实例需要初始化管理员；仅在受信任本机执行（返回包含用户密钥，请自行安全保存，不要公开）：

```sh
read -rsp 'Gateway key: ' GATEWAY_KEY; printf '\n'
curl -fsS http://127.0.0.1:8420/v3/internal/meta/user/init-admin \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'x-tdai-service-id: default' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin"}'
unset GATEWAY_KEY
```

使用返回的管理员 `user_key` 登录；已有管理员返回冲突时应使用已有凭证，不要删除数据重建。然后创建普通用户、团队、Agent 和任务，并按需要绑定记忆资产。日常客户端使用普通用户 key，管理员 key 不应分发给所有 Agent。Panel 的认证加密 secret 文件必须持续保留和备份。详见 [Panel 指南](MemoryPanel/README.md)。

### Proxy 接入 Agent

```sh
cd MemoryProxy
node --version  # 必须是 v22.x
npm install
cp config.example.yaml config.yaml
chmod 600 config.yaml
```

编辑本地 `config.yaml`，不要直接使用模板中的占位服务：

- `server.host: 127.0.0.1`，`server.port: 8096`。
- `upstream.url` / `upstream.apiKey` 填自己的、与客户端协议兼容的上游；这是模型推理授权，不是 Embedding Key / Core OAuth。
- `auth.url`、`tdai.endpoint`、`skill.endpoint` 指向 Core（例如 `http://127.0.0.1:8420`）。
- `tdai.apiKey`、`skill.serviceToken` 使用 Gateway Key；实例相关 `serviceId` 对齐实际实例。
- `storage.enabled: true`、`storage.backend: postgres`；数据库来自共享 TOML，不重复在 YAML 写 URL。公共 PG 路径可设 `redis.enabled: false`；私有扩展可能仍依赖 Redis。
- 按实际部署配置 / 关闭 Knowledge、遥测、账单和私有扩展，不保留不适用的示例端点。

```sh
npm run start:config
curl -fsS http://127.0.0.1:8096/health
```

客户端接入时使用 Panel 提供的接入地址和普通用户 `user_key`，选择真实上游支持的模型；例如路由 `http://127.0.0.1:8096/proxy/default/v1/chat/completions`。SDK 若自行追加 `/chat/completions`，base URL 仅配到 `/proxy/default/v1`，不要重复路径。首次会话选团队 / Agent / 任务，后续由 Proxy 注入上下文与回写。客户端专用路由见 [Proxy 文档](MemoryProxy/README.md)，旧安装指南中的客户端示例仅供协议接入参考。

## 8. 不用 Docker：原生 Core

先准备可达的 PostgreSQL + pgvector，修改共享 TOML 为主机可达 URL，根 `.env` 中填好 Embedding / Gateway 配置。以下显式加载根 `.env`；普通 `npm` 命令不会自动加载根环境文件：

```sh
cd MemoryCore
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
TDAI_GATEWAY_CONFIG="$PWD/tdai-gateway.postgres.yaml" \
TDAI_GATEWAY_HOST=127.0.0.1 \
TDAI_DATA_DIR="$PWD/data" \
node --env-file=../.env --import tsx src/gateway/server.ts
```

不要使用 YAML 默认的 `/data/...` 作为无权限用户的原生目录；这里通过 `TDAI_DATA_DIR` 覆盖。OAuth CLI 仍需在自己进程中配置 vault 加密环境变量。只需 Gateway 时不要求安装或运行宿主 Agent。

## 9. 排错、验证和上线前检查

- `ECONNREFUSED`：检查实际运行环境和数据库主机名；容器的 `127.0.0.1` 不是宿主机，也不是 `postgres` 服务。
- TOML / backend 冲突：检查 `DATABASE_URL`、旧模块 URL、YAML 和 Panel 示例的 file 模式；按配置优先级修复，不要依靠隐式回退。
- Embedding `401/403`：检查提供商密钥和模型权限；`404` 检查重复 `/embeddings`；维数错误先核对真实返回长度。
- L0 能查询而 L1 为空：默认提取关闭，或尚未完成提取；检查 LLM 授权、队列与日志。仅开启 OAuth 登录不自动生成记忆。
- `401` 用户接口：区分 Gateway Bearer、`x-tdai-service-id`、`x-tdai-user-key`，不要用 Embedding Key 登录 Panel。
- OAuth 回调失败：浏览器必须能访问 CLI 的 `127.0.0.1` 端口；远程浏览器与 CLI 未必共用网络命名空间。
- 对外部署：TLS、最小权限、防火墙、独立备份数据库及密钥、验证恢复、容量与负载测试。不要直接公开内部管理接口。

本地开发检查（各模块先安装依赖）：

```sh
node scripts/sync-db-config.mjs --check
(cd MemoryCore && npm run typecheck:postgres && npm run test:postgres && npm run typecheck:oauth && npm run test:oauth)
(cd MemoryPanel && npm run typecheck && npm test)
(cd MemoryProxy && npm run typecheck && npm test)
(cd MemoryKnowledge && npm run typecheck && npm test && npm run build)
```

不设置 `PG_TEST_URL` 时相关测试使用 PGlite，部分原生测试跳过；真实数据库测试只允许隔离的 `*_test` 数据库，会创建 / 删除测试 schema，切勿指向业务库。当前验证范围见 [README](README.md#验证边界) 和 [PostgreSQL 说明](POSTGRES.md#verification-evidence)。
