# 公开垂直搜索源

SQ-031 首批原生适配器包含 GitHub 仓库和 Crossref 学术出版物。DSH 宿主搜索源与选择策略由插件接入层控制。

| 来源 ID | 范围 | 候选结果 | 凭据 |
|---|---|---|---|
| `github` | GitHub 公共仓库及仓库搜索限定符 | 仓库链接、名称和描述 | 匿名访问 |
| `crossref` | Crossref 出版物书目记录 | DOI 链接、标题、期刊和出版商 | 匿名访问 |

GitHub 适配器调用仓库搜索接口。GitHub 会按出口 IP 计算匿名搜索额度，多个实例与其他共享出口请求可能使用同一个额度。 [GitHub 搜索接口](https://docs.github.com/en/rest/search/search#search-repositories) · [GitHub REST 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Crossref 适配器调用公开 API 的书目查询，只取 DOI、标题、期刊与出版商字段。结果中的 DOI 链接可能跳转到出版商页面，书目索引命中本身不代表可读取全文。 [Crossref API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) · [Crossref 访问方式与约束](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)

每次查询最多取 10 条候选，单个响应限制 384 KiB。来源实例串行请求，队列中取消的请求不会发送。限流时优先使用上游提供的 `Retry-After` 或 GitHub 的重置时间，冷却期间立即返回限流，进程内不重试。请求使用固定 HTTPS 端点、拒绝重定向、且不携带 Cookie 或 API 密钥。上游错误正文不进入工具结果。

自动测试覆盖构造 API 请求、映射候选、识别限流、取消排队、处理损坏与超限响应。CI 使用模拟请求。实际匿名调用会消耗出口的公开额度。
