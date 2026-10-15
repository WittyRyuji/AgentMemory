# 迁移、运维与排错

[返回快速开始](INSTALL_CN.md) · [数据库迁移范围与工具](POSTGRES.md)

<a id="migration"></a>
## 从旧 Compose 迁移

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

   **不要加 `-v`，不要删旧卷，不允许两个 PostgreSQL 容器同时挂同一数据卷。** 旧布局保留原始必填环境变量要求；使用旧安装的 `.env`。原来的 Core / Knowledge 工作卷也保留，但新项目会建新的缓存卷；业务数据从 PostgreSQL 恢复，本地额外文件需自行检查备份。已有 Panel 迁移还必须保留原 `panel-session-secret`，见 [Panel 配置](OPTIONAL_CN.md#panel)。
4. 先 `docker volume inspect` 核对旧卷存在，再按 [安装指南](INSTALL_CN.md#start) 启动；不要为拼错的旧卷名执行 `docker volume create`。验证原用户、会话和数据仍在后再恢复写入。

共享数据库地址覆盖、TLS 和配置冲突见 [配置规则](config/README.md)。每份 Compose 有独立 project name；不要给所有组件设置同一个 `-p` / `COMPOSE_PROJECT_NAME`。部署第二套实例需使用不同的网络、项目名、卷名和宿主端口。

## 日常启停与配置更新

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

可选组件同理使用各自文件的 `ps`、`logs`、`up`、`down`。不要在有用数据上使用 `down -v`，它仍会删除非 external 的应用卷，尤其 Panel 的认证 secret。

私有 `.env` / TOML 不要打包进镜像或提交到 Git；展开后的 `docker compose config` 可能包含密钥，检查结构时用 `config --quiet`。

## 排错与开发检查

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

## 文档结构参考

快速开始参考以下官方指南的组织方式，配置细节以本仓库实现为准：

- [Immich Quick start](https://docs.immich.app/overview/quick-start/)：准备文件、填写配置、启动、首次使用。
- [Qdrant Local Quickstart](https://qdrant.tech/documentation/quickstart/)：启动后立刻写入并查询数据。
- [Mem0 Open Source](https://docs.mem0.ai/open-source/overview)：先完成 add/search 闭环，再阅读组件配置与高级能力。
