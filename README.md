# AgentMemory

基于 TencentDB Agent Memory 的自托管 Agent 记忆服务。本仓库 `main` 使用 PostgreSQL + pgvector 持久化数据，提供独立 OAuth 推理入口，并保留 Gateway / SDK 与团队、Agent 权限能力。

## 快速开始

按照 [安装 → 调用 → 最小验证](INSTALL_CN.md) 顺序完成：

1. 安装 PostgreSQL + Core，填写数据库密码和 Embedding 配置。
2. 调用 `/capture` 写入对话，再用 `/search/conversations` 查回。
3. 对照健康状态、写入条数和查询内容确认成功。

最小安装只需 **2 个容器**。默认先保存和查询 L0 原始对话；结构化记忆与 Skill 需要另行配置 LLM 并启用异步提取。

## 按需扩展

| 组件 | 用途 | 本机端口 |
| --- | --- | --- |
| PostgreSQL + pgvector | 共享持久化存储 | 不发布 |
| Core | 对话、记忆、Skill、权限和任务 API | 8420 |
| [Panel](OPTIONAL_CN.md#panel) | 用户、团队、Agent 和资产管理，内含 Web UI | 8123 |
| [Proxy](OPTIONAL_CN.md#proxy) | 转发模型请求，注入记忆与回写会话 | 8096 |
| [Knowledge](OPTIONAL_CN.md#knowledge) | CodeGraph / Wiki，默认仅开启 CodeGraph | 8421 |

完整部署为 **5 份 Compose / 5 个容器**，各自独立启停。已有安装先看 [卷迁移](OPERATIONS_CN.md#migration)。

## 能力

- 分层记忆：保存原始会话，检索事实与上下文；配置 LLM 后进行 L1/L2/L3 和 Skill 提取。
- 共享资产：Skill 版本与资源、Wiki 文档关系、CodeGraph 符号与调用关系，按团队和 Agent 绑定。
- 权限隔离：用户、团队、Agent、资产所有权和 ACL；新资产不会因为共用数据库自动公开。
- Agent 接入：经 Proxy 对接支持的 OpenAI / Anthropic 协议客户端，或直接使用 Gateway / SDK。客户端的模型协议和上游仍需匹配。
- 持久化：PG 保存权威业务数据、任务状态与文件对象；CodeGraph 的本地 SQLite 是可重建索引，配置、临时工作目录、日志仍在磁盘。
- 兼容：原 SQLite / Tencent / Mongo / COS 等路径仍保留；原地迁移必须停写、备份并使用对应迁移工具，不能仅更换连接串。

## 文档

- [安装、调用与最小验证](INSTALL_CN.md)
- [Embedding（含方舟完整 endpoint）](EMBEDDING_CN.md) · [OAuth 授权与推理](OAUTH.md)
- [可选模块与 Agent 接入](OPTIONAL_CN.md) · [原生部署](NATIVE_CN.md)
- [迁移、日常运维与排错](OPERATIONS_CN.md) · [数据库配置](config/README.md) · [PostgreSQL 范围与迁移工具](POSTGRES.md)
- API：[Core](MemoryCore/v3-api-memorycore-doc.md)、[Panel](MemoryPanel/panel-api-doc.md)、[Proxy](MemoryProxy/v3-api-memoryproxy-doc.md)、[Knowledge](MemoryKnowledge/v3-api-memoryknowledge-doc.md)
- [历史镜像及客户端参考](INSTALL_LEGACY_CN.md) · [贡献指南](CONTRIBUTING_CN.md) · [上游路线图](ROADMAP_CN.md) · [许可证](LICENSE)

## 验证边界

四模块 PostgreSQL 契约 / 集成测试、OAuth 模拟测试和 Compose 静态配置检查已有通过记录。Core 的真实 HTTP 写入、检索及重启持久化检查使用过真实 PostgreSQL，但 Embedding 使用合成端点，详见 [验证记录](POSTGRES.md#verification-evidence)。

尚未完成五容器实际联调、真实 Embedding（包括方舟）、真实账号 OAuth 授权与推理、生产迁移和提取质量验证。健康检查与 L0 查询通过不代表这些能力可用。

## 致谢

感谢 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)、[CodeGraph](https://github.com/colbymchenry/codegraph)、[Hermes Agent](https://github.com/nousresearch/hermes-agent) 以及相关开源贡献者。原项目的代码与许可说明保留在各模块中。
