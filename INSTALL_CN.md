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
cp .env.example .env
chmod 600 config/db.toml
```

已有安装先备份，勿覆盖现有配置。新安装按以下步骤；旧 SQLite / 文件 / Redis / COS 数据先阅读 [迁移说明](POSTGRES.md)，改连接串不会自动迁移。

## 2. 配置数据库

编辑根目录 `config/db.toml`。Compose 内服务使用 `postgres` 主机名：

```toml
[postgres]
url = "postgresql://agentmemory@postgres:5432/agentmemory"
password_env = "POSTGRES_PASSWORD"
```

密码只在根 `.env` 的 `POSTGRES_PASSWORD` 填一次，TOML 仅保存变量名；加载器读取进程环境并自动百分号编码原始密码，无需手工拼 DSN。变量缺失或为空会拒绝启动。`password_env` 是显式引用，不执行 shell 或通用 `${VARIABLE}` 展开。原生运行把 URL 主机改成数据库实际可达的地址，例如 `127.0.0.1:5432`。

四模块共同读取此文件；可用 `[core]`、`[knowledge]`、`[panel]`、`[proxy]` 的 `url` 分别覆盖。移除旧的冲突数据库环境变量和显式非 PG 后端设置，否则启动会拒绝。详见 [路径、优先级、TLS 与挂载规则](config/README.md)。

## 配置 Embedding

编辑刚复制的**仓库根目录** `.env`，在本机填写真实值；核心字段如下：

```dotenv
POSTGRES_PASSWORD='REPLACE_WITH_DB_PASSWORD'
POSTGRES_VOLUME=agentmemory-postgres
AGENTMEMORY_NETWORK=agentmemory
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
| `config/db.toml` | 数据库地址和环境变量名，不保存密码 |
| `.env` 的 `POSTGRES_PASSWORD` | PostgreSQL 原始密码，服务器和四模块共用 |
| `MEMORY_EMBEDDING_API_KEY` | 文本转向量 API；与 OAuth 独立 |
| `TDAI_GATEWAY_API_KEY` | 服务间访问 Core 的 Bearer 密钥 |
| `user_key` | Panel / Agent 用户身份，由 Core 创建 |
| `AGENTMEMORY_OAUTH_KEY` | OAuth vault 加密密钥，不是 API Key |

`.env` 和 `config/db.toml` 已被 Git 忽略；不要提交、截图、粘贴日志或把它们打包进镜像。不要把真值直接写入受版本管理的 YAML。含 `$`、`#` 等字符的原始密码建议用单引号包裹；如密码本身含引号，按所用环境文件解析器规则处理，或由运行时秘密管理器注入。不要 `source` 不可信文件。避免将展开后的 `docker compose config` 输出分享给别人，其中可能包含密钥。

## 3. 一个组件一个 Compose：共 5 个容器

| 组件 | 根目录 Compose 文件 | 必需 / 可选 |
| --- | --- | --- |
| PostgreSQL + pgvector | `docker-compose.postgres.yaml` | 必需，pgvector 是扩展，不另占容器 |
| Core | `docker-compose.core.yaml` | 必需 |
| Panel（含编译后的 Web UI） | `docker-compose.panel.yaml` | 可选 |
| Proxy | `docker-compose.proxy.yaml` | 可选 |
| Knowledge | `docker-compose.knowledge.yaml` | 可选，默认仅 CodeGraph |

完整部署 **5 份 Compose、5 个容器**；最小部署 **2 个**。每份仅一个 service、一个固定且不同的 project name，不使用跨文件 `depends_on`。不要用多个 `-f` 合并运行，也不要给所有文件设置同一个 `-p` / `COMPOSE_PROJECT_NAME`。按下面顺序启动并检查依赖就绪。外部网络只供这套部署使用，服务名 `postgres`、`core`、`panel`、`proxy`、`knowledge` 是稳定 DNS。第二套部署需另选网络、项目名、卷名和宿主端口，避免别名冲突。

### 3.1 已有旧 Compose 安装：先迁移卷，不要直接启动新版

旧根 Compose 同时运行 PostgreSQL / Core / Knowledge；现在同名文件只负责 PostgreSQL。旧数据库卷通常为 `<旧项目名>_agentmemory-postgres`，不能想当然使用新卷，否则会看到空库。

1. 停写并备份数据库和配置。更新代码前记录旧项目名和数据库容器实际挂载的卷：

   ```sh
   docker compose ls
   docker inspect OLD_POSTGRES_CONTAINER --format '{{range .Mounts}}{{println .Type .Name .Destination}}{{end}}'
   ```

2. 将真实卷名填入根 `.env` 的 `POSTGRES_VOLUME`。如果不是 Docker named volume，先制定对应存储迁移方案，不套用这些命令。
3. 更新代码后，以原项目名使用保留的旧布局停止旧容器（将 `OLD_PROJECT` 替换为实际名称；原先用过 knowledge profile 时同样适用）：

   ```sh
   docker compose --env-file .env -p OLD_PROJECT -f deploy/legacy/docker-compose.postgres.yaml --profile knowledge down
   ```

   **不要加 `-v`，不要删旧卷，不允许两个 PostgreSQL 容器同时挂同一数据卷。** 旧布局保留原始必填环境变量要求；使用旧安装的 `.env`。原来的 Core / Knowledge 工作卷也保留，但新项目会建新的缓存卷；业务数据从 PostgreSQL 恢复，本地额外文件需自行检查备份。已有 Panel 迁移还必须保留原 `panel-session-secret`，见第 7 节。
4. 先 `docker volume inspect` 核对旧卷存在，再按下一节启动；不要为拼错的旧卷名执行 `docker volume create`。验证原用户、会话和数据仍在后再恢复写入。

### 3.2 新安装：准备外部网络和数据库卷

以下默认名与上面的 `.env` 一致；已有安装使用核对过的卷名，跳过创建数据库卷：

```sh
docker network inspect agentmemory >/dev/null 2>&1 || docker network create agentmemory
# 仅新安装执行；已有安装不得用它代替卷核对：
docker volume create agentmemory-postgres
```

这些资源由部署者显式创建。PostgreSQL 卷声明为 external，Compose 找不到会拒绝启动，避免静默生成空库；各组件 `down` 不会删除共享网络或外部数据库卷。

### 3.3 分别启动 PostgreSQL、Core

```sh
docker compose --env-file .env -f docker-compose.postgres.yaml up -d --wait
docker compose --env-file .env -f docker-compose.core.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8420/health
```

使用支持 `up --wait` 的 Compose v2。PostgreSQL 就绪后才启动 Core。五份 Compose 显式将同一个 `POSTGRES_PASSWORD` 传给各自容器；仅有 `.env` 插值不会自动传入容器。Compose 还将 Embedding 三个变量传入 Core，并只读挂载数据库 TOML 和 Gateway YAML；配置文件不存在会报错，不会创建同名目录。数据库不映射宿主端口；所有 HTTP 端口仅映射 `127.0.0.1`。首次构建需要下载依赖。

健康检查只证明相应服务的健康端点响应，不证明外部 Embedding / LLM 或完整模块联调成功。逐个查看状态 / 日志：

```sh
docker compose --env-file .env -f docker-compose.postgres.yaml ps
docker compose --env-file .env -f docker-compose.core.yaml ps
docker compose --env-file .env -f docker-compose.core.yaml logs --tail=100
```

修改 `.env` 后重新创建对应应用容器，不能只 `restart`。已有数据库卷的角色密码不会因修改 `POSTGRES_PASSWORD` 自动改变；轮换密码须先按 PostgreSQL 管理流程更改角色密码，再同步环境并重建应用容器：

```sh
docker compose --env-file .env -f docker-compose.core.yaml up -d --force-recreate --wait
```

单独停止 Core 不影响 PostgreSQL：

```sh
docker compose --env-file .env -f docker-compose.core.yaml down
# 停止数据库前，先停止所有使用它的应用组件：
docker compose --env-file .env -f docker-compose.postgres.yaml down
```

可选组件同理使用各自文件的 `ps`、`logs`、`up`、`down`。不要在有用数据上使用 `down -v`，它仍会删除非 external 的应用卷，尤其 Panel 的认证 secret。修改 `POSTGRES_PASSWORD` 不会更改已初始化数据库密码；需按数据库管理流程修改实际角色密码及所有连接配置。

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
   node --env-file=../.env --import tsx scripts/oauth/cli.ts login --account owner --vault-id agentmemory
   node --env-file=../.env --import tsx scripts/oauth/cli.ts status --account owner --vault-id agentmemory
   node --env-file=../.env --import tsx scripts/oauth/cli.ts models --account owner --vault-id agentmemory
   ```

3. 所有者在浏览器确认 AgentMemory 自己的授权；使用 `models` 实际返回的模型 slug 设置 YAML `llm.provider: oauth` 及其 `oauth` 块，随后显式启用提取。
4. CLI 和 Core 必须使用同一数据库、加密密钥、account 和 vaultId。Core Compose **没有传入 OAuth 密钥**，需要通过受保护的 Compose override / secret 注入配置将命名环境变量传给 Core，并重新创建容器。

Compose 的 `postgres` 仅在容器网络可解析，数据库默认不对宿主发布。主机 CLI 不能直接照抄此连接串；应选择安全可达的同一数据库部署 / 网络方案。远程登录需要精确的 SSH 回环转发，不得公开 OAuth callback。

OAuth 不借用 Codex / Hermes / OpenClaw 会话，不提供 Embedding API，也不自动代替 Proxy 上游或 Knowledge Wiki LLM。配额、模型权限和账号资格由提供商决定；失败不会自动切换到付费 API Key 或本地模型。真实账号授权和推理尚未验证。

如选用原有 API-key LLM，按 [Gateway 配置样例](MemoryCore/tdai-gateway.standalone.yaml) 配置自己的 `llm` 块，再明确开启提取；这可能产生提供商费用，不能只填 Embedding Key。

## 6. 可选：Knowledge

独立 Knowledge Compose 仅启用 CodeGraph；先确保 PostgreSQL 已健康：

```sh
# 先在根 .env 设置非空 KNOWLEDGE_SERVICE_KEY
# 调用方使用相同服务凭证；不要将未保护服务暴露到公网。
docker compose --env-file .env -f docker-compose.knowledge.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8421/health
```

默认命令为 `--code-graph-only`。Wiki 需要额外配置它自己的 LLM 路径及绑定，不能把 CodeGraph 健康当作 Wiki 已就绪。完整功能、迁移和持久化边界见 [Knowledge README](MemoryKnowledge/README.md) 和 [Knowledge PostgreSQL](MemoryKnowledge/POSTGRES.md)。

## 7. 可选：Panel 与 Proxy

### 容器启动（推荐与前文配套）

先准备 Panel 注册表：

```sh
cp MemoryPanel/config/metadata-instances.example.json MemoryPanel/config/metadata-instances.json
chmod 600 MemoryPanel/config/metadata-instances.json
```

只保留实际实例，`id` 与 Core 一致，`api_key` 填 Gateway Key。容器内调用 Core 使用 `http://core:8420`；`proxy_endpoint` 用于客户端接入展示，应填写**客户端可达的地址**，本机使用 `http://127.0.0.1:8096`（不用容器内部 DNS）。未部署 Proxy 则省略该字段：

```json
{"instances":[{"id":"default","name":"本地 AgentMemory","gateway_endpoint":"http://core:8420","proxy_endpoint":"http://127.0.0.1:8096","api_key":"REPLACE_WITH_GATEWAY_KEY"}]}
```

```sh
docker compose --env-file .env -f docker-compose.panel.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8123/health
```

浏览器打开 `http://127.0.0.1:8123`；此容器同时托管构建后的 Web UI，不需要另起前端容器。构建 UI 失败应修复依赖 / 构建问题，不应把 `WEB_UI=0` 占位页当成功界面。首次管理员初始化见下方通用命令。Panel 默认关闭 Knowledge LLM binding 同步，部署 Wiki 并配置好 Proxy 后才按 Knowledge 指南启用。

`agentmemory-panel_panel-data` 卷保留 `/app/data/panel-session-secret`，需连同数据库独立备份。已有 Panel 迁移必须在首次启动前把原 secret 按原内容和安全权限放到此卷的对应路径，不能让新容器替换生成，否则旧加密身份绑定无法解密。若已有 Panel 使用其他卷，可以在受保护 override 中把 `panel-data` 映射为确认过的 external 卷。

Proxy 先创建专用 PG 配置，不直接使用包含大量占位集成的完整版模板：

```sh
cp MemoryProxy/config.postgres.example.yaml MemoryProxy/config.yaml
chmod 600 MemoryProxy/config.yaml
```

编辑 `upstream.url` / `upstream.apiKey` 为真实且协议兼容的模型上游；`tdai.apiKey` 和 `skill.serviceToken` 填 Gateway Key，两个 `serviceId` 与 Core 实例一致。这些 YAML 字段**不会展开 `${VAR}`**，需在本地受保护文件填写实际值。根 `.env` 另加非空 `TDAI_PROXY_ADMIN_API_KEY`，用于 Proxy 运维接口鉴权（独立于普通用户 key）。数据库仍来自根 `config/db.toml`。

Proxy 镜像以 UID `10001` 运行。两个只读 bind 文件 `config/db.toml`、`MemoryProxy/config.yaml` 必须能被容器内该 UID 读取；不要为了方便设为全员可读。Linux 无 user namespace 映射时可给该 UID 精确只读 ACL，例如 `setfacl -m u:10001:r config/db.toml MemoryProxy/config.yaml`，目录需有必要遍历权限。Docker Desktop / rootless / user namespace 下应按实际 UID 映射设置权限并验证；不要照搬 Linux ACL 或把容器改成 root 绕过。

```sh
docker compose --env-file .env -f docker-compose.proxy.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8096/health
```

Proxy / Panel 启动前 Core 应已健康；Knowledge 可独立于这两个组件启动 CodeGraph。Wiki、真实上游推理和用户登录需单独验证；没有上游 Key 时不要启动 Proxy 并期待它代用 Embedding Key / Core OAuth。完整客户端接入说明见本节末尾。

### 不使用容器时：原生源码服务

以下只适用于原生启动。根 `config/db.toml` 使用对主机可达的数据库 URL；不能直接使用 Docker 网络内的 `postgres`。混合运行时通过 `AGENTMEMORY_DB_CONFIG` 为每个环境选择受保护的等价配置，不要向公网开放数据库。

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
# 在 MemoryPanel 下，终端一（根 .env 加载数据库密码，模块 .env 加载 Panel 设置）：
node --env-file=../.env --env-file=.env --import tsx --watch src/index.ts
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
node --env-file=../.env --import tsx/esm src/index.ts --config config.yaml
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
node scripts/check-compose.mjs  # 需先安装 MemoryProxy 依赖
bash scripts/check-knowledge-entrypoint.sh
(cd MemoryCore && npm run typecheck:postgres && npm run test:postgres && npm run typecheck:oauth && npm run test:oauth)
(cd MemoryPanel && npm run typecheck && npm test)
(cd MemoryProxy && npm run typecheck && npm test)
(cd MemoryKnowledge && npm run typecheck && npm test && npm run build)
```

不设置 `PG_TEST_URL` 时相关测试使用 PGlite，部分原生测试跳过；真实数据库测试只允许隔离的 `*_test` 数据库，会创建 / 删除测试 schema，切勿指向业务库。当前验证范围见 [README](README.md#验证边界) 和 [PostgreSQL 说明](POSTGRES.md#verification-evidence)。
