# 可选能力与模块

先完成 [安装 → 调用 → 最小验证](INSTALL_CN.md)。所有 Compose 命令在仓库根目录执行，每个组件使用自己的文件独立启动；完整部署仍为 5 个容器。

- [LLM 提取](#extraction)：从原始对话生成记忆
- [Panel](#panel)：管理用户、团队与资产
- [Proxy](#proxy)：接入 Agent 客户端
- [Knowledge](#knowledge)：CodeGraph / Wiki

<a id="extraction"></a>
## LLM 提取

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

提取是异步任务。完成授权、配置并开启提取后，重新写入一段有明确事实的对话，再检查任务 / 日志及 `/search/memories` 或 `/recall` 的结果。不要把 `/capture` 的 `scheduler_notified` 当作提取已完成；L1 为空时先排查任务和 LLM，而不是反复重装。API 字段见 [Core API](MemoryCore/v3-api-memorycore-doc.md)。

<a id="panel"></a>
## Panel

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

浏览器打开 `http://127.0.0.1:8123`；此容器同时托管构建后的 Web UI，不需要另起前端容器。构建 UI 失败应修复依赖 / 构建问题，不应把 `WEB_UI=0` 占位页当成功界面。首次管理员初始化见下方。Panel 默认关闭 Knowledge LLM binding 同步，部署 Wiki 并配置好 Proxy 后才按 Knowledge 指南启用。

`agentmemory-panel_panel-data` 卷保留 `/app/data/panel-session-secret`，需连同数据库独立备份。已有 Panel 迁移必须在首次启动前把原 secret 按原内容和安全权限放到此卷的对应路径，不能让新容器替换生成，否则旧加密身份绑定无法解密。若已有 Panel 使用其他卷，可以在受保护 override 中把 `panel-data` 映射为确认过的 external 卷。

首次空实例需要初始化管理员；仅在受信任本机执行（返回包含用户密钥，请自行安全保存，不要公开）：

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

<a id="proxy"></a>
## Proxy

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

客户端接入时使用 Panel 提供的接入地址和普通用户 `user_key`，选择真实上游支持的模型；例如路由 `http://127.0.0.1:8096/proxy/default/v1/chat/completions`。SDK 若自行追加 `/chat/completions`，base URL 仅配到 `/proxy/default/v1`，不要重复路径。首次会话选团队 / Agent / 任务，后续由 Proxy 注入上下文与回写。客户端专用路由见 [Proxy 文档](MemoryProxy/README.md)，旧安装指南中的客户端示例仅供协议接入参考。

<a id="knowledge"></a>
## Knowledge

独立 Knowledge Compose 仅启用 CodeGraph；先确保 PostgreSQL 已健康：

```sh
# 先在根 .env 设置非空 KNOWLEDGE_SERVICE_KEY
# 调用方使用相同服务凭证；不要将未保护服务暴露到公网。
docker compose --env-file .env -f docker-compose.knowledge.yaml up -d --build --wait
curl -fsS http://127.0.0.1:8421/health
```

默认命令为 `--code-graph-only`。Wiki 需要额外配置它自己的 LLM 路径及绑定，不能把 CodeGraph 健康当作 Wiki 已就绪。完整功能、迁移和持久化边界见 [Knowledge README](MemoryKnowledge/README.md) 和 [Knowledge PostgreSQL](MemoryKnowledge/POSTGRES.md)。

不用 Docker 时见 [原生部署](NATIVE_CN.md)。
