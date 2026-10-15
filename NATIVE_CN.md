# 原生源码部署

[返回快速开始](INSTALL_CN.md) · [可选模块](OPTIONAL_CN.md)

使用 Node.js **22.18+ 的 22.x 系列**和 npm；Proxy 入口严格要求 22.x。准备 PostgreSQL 17 + pgvector，由管理员创建 `public.vector` 扩展，并允许应用创建 schema / 表。

先按 [获取代码和配置](INSTALL_CN.md#11-获取代码和配置) 准备仓库、根 `.env` 和 `config/db.toml`，填写密钥。下面各模块的命令分别从仓库根目录开始。

## Core

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

## Panel 与 Proxy

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

健康检查 `http://127.0.0.1:8123/health`，开发界面 `http://127.0.0.1:5173`。管理员初始化见 [Panel 初始化](OPTIONAL_CN.md#panel)。

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
