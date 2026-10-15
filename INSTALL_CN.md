# 安装 → 调用 → 最小验证

本指南用于 `WittyRyuji/AgentMemory` 的 `main` **全新安装**：启动 PostgreSQL + Core 两个容器，写入一轮对话，再把它查回来。已有数据先看 [迁移步骤](OPERATIONS_CN.md#migration)。

需要：Git、Bash、curl、Docker Engine 和支持 `up --wait` 的 Compose v2，以及一个 Embedding API 的地址、密钥、模型与输出维数。宿主机不需要 Node.js。所有命令均在仓库根目录执行。

## 1. 安装

### 1.1 获取代码和配置

```sh
git clone --branch main --single-branch https://github.com/WittyRyuji/AgentMemory.git
cd AgentMemory
umask 077
cp config/db.example.toml config/db.toml
cp .env.example .env
chmod 600 config/db.toml .env
```

保留 `config/db.toml` 的默认内容：

```toml
[postgres]
url = "postgresql://agentmemory@postgres:5432/agentmemory"
password_env = "POSTGRES_PASSWORD"
```

数据库密码只在根 `.env` 填一次，TOML 通过 `password_env` 引用；加载器自动编码密码。`postgres` 是容器内数据库地址。

<a id="embedding"></a>
### 1.2 填写密钥和 Embedding

编辑根 `.env`，替换三个 `REPLACE_WITH_...` 值。下面使用 OpenAI Embedding，网络、卷名和实例名保持默认：

```dotenv
POSTGRES_PASSWORD='REPLACE_WITH_DB_PASSWORD'
POSTGRES_VOLUME=agentmemory-postgres
AGENTMEMORY_NETWORK=agentmemory
TDAI_GATEWAY_API_KEY='REPLACE_WITH_A_LONG_RANDOM_GATEWAY_KEY'
TDAI_INSTANCE_ID=default
MEMORY_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
MEMORY_EMBEDDING_FORMAT=openai
MEMORY_EMBEDDING_API_KEY='REPLACE_WITH_EMBEDDING_PROVIDER_KEY'
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

`MEMORY_EMBEDDING_ENDPOINT` 填**完整请求地址（含协议与路径）**，不会追加 `/embeddings`。Gateway Key 是调用本服务的凭证，Embedding Key 是向量提供商的凭证，两者分开填写；私有配置不要提交到 Git。

这个示例对应 `MemoryCore/tdai-gateway.postgres.yaml` 中已有的 `memory.embedding.dimensions: 1536`，无需改动。若使用其他模型，先把维数改成实际输出长度。

使用火山方舟时，只替换上述 Embedding 四项并调整维数，按 [方舟配置示例](EMBEDDING_CN.md#火山方舟多模态接口) 填写完整 `/api/v3/embeddings/multimodal` 地址及 `ark-multimodal` 协议。方舟支持多模态，但本项目当前只对文本生成向量。

<a id="start"></a>
### 1.3 启动数据库和 Core

```sh
docker network inspect agentmemory >/dev/null 2>&1 || docker network create agentmemory
docker volume create agentmemory-postgres
docker compose --env-file .env -f docker-compose.postgres.yaml up -d --wait
docker compose --env-file .env -f docker-compose.core.yaml up -d --build --wait
```

第一次会从当前源码构建 Core。每个组件使用自己的 Compose 文件独立运行，不合并多个 `-f`。数据库不发布宿主端口，Core 仅监听宿主 `127.0.0.1:8420`。

## 2. 调用

下面在**同一个 Bash 终端**执行。输入刚才设置的 Gateway Key；会话名用于把同一段对话的写入和查询关联起来。

```sh
read -rsp 'Gateway key: ' GATEWAY_KEY; printf '\n'
```

### 写入一轮对话

```sh
curl -fsS http://127.0.0.1:8420/capture \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"session_key":"install-check","user_content":"AgentMemory PostgreSQL 安装检查","assistant_content":"已记录安装检查。"}'
```

成功响应中 `l0_recorded` 应为 `2`，表示保存了用户和助手两条原始消息；另有 `scheduler_notified` 字段，它不是提取完成标志。

### 查回这段对话

```sh
curl -fsS http://127.0.0.1:8420/search/conversations \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"PostgreSQL","session_key":"install-check"}'
unset GATEWAY_KEY
```

响应中 `total` 应大于 `0`，`results` 是包含刚才“AgentMemory PostgreSQL 安装检查”的文本。后续调用沿用这两个接口，替换会话名和消息即可。

这是本机、单实例的 **L0 原始对话**调用。默认配置关闭 LLM 提取，不会因为 `/capture` 成功就自动生成 L1/L2/L3 或 Skill。要提取和召回结构化记忆，继续 [配置 OAuth / LLM 并启用异步提取](OPTIONAL_CN.md#extraction)。团队 / Agent 客户端接入见 [Proxy 指南](OPTIONAL_CN.md#proxy)。

## 3. 最小验证

```sh
curl -fsS http://127.0.0.1:8420/health
```

确认以下三项即可完成首次安装检查，无需先装其余模块：

- 健康响应：`status` 为 `ok`，`stores.vectorStore` 为 `true`，`services.stateBackend` 为 `connected`。
- 上一步写入：`l0_recorded: 2`。
- 上一步查询：`total > 0`，`results` 包含测试消息。

这验证了 Core 的基础 L0 写入 / 查询；**不代表真实 Embedding、OAuth 推理或 L1 提取已验证**。查询可以使用 PostgreSQL 全文检索。若不符合预期，先看 Core 日志和 [排错指南](OPERATIONS_CN.md)：

```sh
docker compose --env-file .env -f docker-compose.core.yaml logs --tail=100
```

## 接下来

- [可选模块](OPTIONAL_CN.md)：Panel、Proxy、Knowledge，以及 LLM 提取。完整部署是五份独立 Compose / 五个容器；pgvector 包含在数据库中，Panel 包含 Web UI。
- [Embedding 参数与方舟协议](EMBEDDING_CN.md) · [独立 OAuth](OAUTH.md)
- [原生源码部署](NATIVE_CN.md) · [迁移、启停、备份与排错](OPERATIONS_CN.md)
- [共享数据库配置](config/README.md) · [Core API](MemoryCore/v3-api-memorycore-doc.md)

当前源码的已验证范围与未验证项见 [README](README.md#验证边界)。旧公共镜像路线保留在 [历史指南](INSTALL_LEGACY_CN.md)，不作为当前 main 的安装入口。
