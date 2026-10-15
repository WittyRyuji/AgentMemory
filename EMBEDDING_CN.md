# Embedding 配置参考

[返回安装指南](INSTALL_CN.md#embedding)

配置位置始终相同：根 `.env` 填完整请求地址、协议、密钥和模型，`MemoryCore/tdai-gateway.postgres.yaml` 的 `memory.embedding` 填输出维数。只编辑已有块。

## OpenAI-compatible

```dotenv
MEMORY_EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
MEMORY_EMBEDDING_FORMAT=openai
MEMORY_EMBEDDING_API_KEY='REPLACE_WITH_EMBEDDING_PROVIDER_KEY'
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

该示例使用 YAML 默认的 `dimensions: 1536`、`sendDimensions: false`。其他兼容提供商按其实际地址、模型和返回向量长度调整。

## 火山方舟多模态接口

```dotenv
MEMORY_EMBEDDING_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal
MEMORY_EMBEDDING_FORMAT=ark-multimodal
MEMORY_EMBEDDING_API_KEY='REPLACE_WITH_ARK_API_KEY'
MEMORY_EMBEDDING_MODEL=doubao-embedding-vision-250615
```

此模型默认输出 `2048` 维，将 YAML 的 `memory.embedding.dimensions` 改为 `2048`，保持 `sendDimensions: false`。

方舟接口本身支持图片等多模态输入；**本项目当前适配器只发送记忆文本，不接收或上传图片**。它对每条文本单独发送 `input: [{"type":"text","text":"..."}]`，读取 `data.embedding`，避免把多条记忆合成一个向量。`ark-multimodal` 表示接口协议，并不表示 AgentMemory 已实现图片记忆。协议参考：[方舟多模态向量化](https://docs.volcengine.com/docs/ark/vectorization?lang=zh)。

## 地址、维数与兼容规则

- `MEMORY_EMBEDDING_ENDPOINT` 是含 `https://` 的完整请求地址，原样使用，不追加路径。
- 旧 `MEMORY_EMBEDDING_BASE_URL` 仅在 endpoint 为空时生效，并追加 `/embeddings`；新安装只填 endpoint。
- `dimensions` 必须等于实际返回长度。只有提供商支持请求体 `dimensions` 时才启用 `sendDimensions`；设为 `false` 不会请求服务端降维。
- 已有向量数据更换模型或维数前，应规划重新向量化 / 迁移，不能混用。
- Embedding 与 LLM 授权独立。ChatGPT OAuth 不提供 Embedding API，也不会自动配置 Proxy 上游或 Knowledge Wiki 的 LLM。

真实提供商连通性需在自己的部署中验证；本仓库的协议测试使用合成端点，尚未实测真实方舟服务。健康检查中 `embeddingService: true` 只表示对象已初始化；L0 查询还可能走全文检索，不能据此证明远程向量化成功。错误排查见 [运维指南](OPERATIONS_CN.md)。
