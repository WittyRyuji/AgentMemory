# AgentMemory（当前 main 安装与使用）

AgentMemory 基于 TencentDB Agent Memory，提供跨会话记忆、Skill、Wiki / CodeGraph 和团队资产管理。本仓库 `main` 已集成 PostgreSQL + pgvector 存储及独立 OAuth 推理入口，保留原有 Gateway、SDK、团队 / Agent ACL 与旧存储模式。

> 请明确使用 `main`。仓库默认分支可能仍是 `feat/server_team`；旧版公共镜像和 `deploy/global-images/start-all.sh` 不代表本分支的 PostgreSQL 配置。

## 从这里开始

```sh
git clone --branch main --single-branch https://github.com/WittyRyuji/AgentMemory.git
cd AgentMemory
```

1. 按 [当前安装与使用指南](INSTALL_CN.md) 配置 `config/db.toml` 和根目录 `.env`。
2. 使用根目录 `docker-compose.postgres.yaml` 从源码启动 PostgreSQL + Core；Knowledge 按需启用。
3. 先验证 `/health`、写入及查询，再按需配置 Panel、Proxy 和 LLM 提取。

**Embedding API Key 填哪里？** 填根目录 `.env` 的 `MEMORY_EMBEDDING_API_KEY`。同处填写 `MEMORY_EMBEDDING_BASE_URL` 和 `MEMORY_EMBEDDING_MODEL`。`MemoryCore/tdai-gateway.postgres.yaml` 的 `memory.embedding` 引用这些变量，Compose 将其传入 Core。`dimensions` 默认 `1536`，必须改成模型实际输出维数。详细示例见 [安装指南](INSTALL_CN.md)。

数据库凭证在 `config/db.toml`；Embedding Key、Gateway Key、OAuth 加密密钥用途不同。ChatGPT OAuth 仅用于已授权的推理，不提供 Embedding API，也不会自动启用 Proxy 上游或 Knowledge Wiki 的 LLM。

## 四个模块

| 模块 | 职责 | 当前入口 / 默认端口 |
| --- | --- | --- |
| [MemoryCore](MemoryCore/) | L0 对话、L1 原子记忆、L2/L3 归纳，Skill、元数据、权限和异步任务 | Gateway `8420` |
| [MemoryPanel](MemoryPanel/) | 用户、团队、Agent、任务及资产管理界面 | 后端 `8123`，开发前端 `5173` |
| [MemoryProxy](MemoryProxy/) | 转发 Agent 的模型请求，注入记忆、回写会话、会话绑定和限流 | `8096`；入口要求 Node 22.x |
| [MemoryKnowledge](MemoryKnowledge/) | 文档 Wiki、代码图谱、知识工具与源文件生命周期 | `8421` |

最小安装只需要 PostgreSQL + Core。根目录 Compose **不包含 Panel / Proxy**；Knowledge 是可选 profile，默认仅启用 CodeGraph。完整操作步骤见安装指南。

## 保留的使用能力

- 分层记忆：保存原始会话，检索事实与上下文；配置 LLM 后进行 L1/L2/L3 和 Skill 提取。
- 共享资产：Skill 版本与资源、Wiki 文档关系、CodeGraph 符号与调用关系，按团队和 Agent 绑定。
- 权限隔离：用户、团队、Agent、资产所有权和 ACL；新资产不会因为共用数据库自动公开。
- Agent 接入：经 Proxy 对接支持的 OpenAI / Anthropic 协议客户端，或直接使用 Gateway / SDK。客户端的模型协议和上游仍需匹配。
- 持久化：PG 保存权威业务数据、任务状态与文件对象；CodeGraph 的本地 SQLite 是可重建索引，配置、临时工作目录、日志仍在磁盘。
- 兼容：原 SQLite / Tencent / Mongo / COS 等路径仍保留；原地迁移必须停写、备份并使用对应迁移工具，不能仅更换连接串。

## 配置与文档

- [安装、Embedding、启动、健康检查与首次使用](INSTALL_CN.md)
- [共享数据库配置和优先级](config/README.md)
- [PostgreSQL 范围、限制和离线迁移](POSTGRES.md)
- [独立 OAuth 登录、模型选择、退出及安全要求](OAUTH.md)
- API：[Core](MemoryCore/v3-api-memorycore-doc.md)、[Panel](MemoryPanel/panel-api-doc.md)、[Proxy](MemoryProxy/v3-api-memoryproxy-doc.md)、[Knowledge](MemoryKnowledge/v3-api-memoryknowledge-doc.md)
- [旧版镜像及各客户端接入参考](INSTALL.md)：涉及镜像、存储和密钥配置时，以当前指南为准。
- [贡献指南](CONTRIBUTING_CN.md) · [上游路线图（不是本分支交付承诺）](ROADMAP_CN.md) · [MIT 许可证](LICENSE)

## 验证边界

基线 `3f8aee8` 的 GitHub PostgreSQL CI 四模块共 297 项通过；另外原生 PostgreSQL 17.11 + pgvector 0.8.0 验证共 253 项通过。Core 已完成真实 HTTP 写入、检索和应用 / 数据库重启持久化检查，但 Embedding 使用合成测试端点。

Panel、Proxy、Knowledge 的原生数据库契约 / 集成测试已通过，不等于独立 HTTP 全链路已验证。Docker Compose、真实 Embedding 提供商、真实账号 OAuth 授权与推理、生产迁移和提取质量仍需部署者验证。默认配置关闭 LLM 提取；健康检查通过不代表这些外部能力已可用。

## 致谢

感谢 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)、[CodeGraph](https://github.com/colbymchenry/codegraph)、[Hermes Agent](https://github.com/nousresearch/hermes-agent) 以及相关开源贡献者。原项目的代码与许可说明保留在各模块中。
