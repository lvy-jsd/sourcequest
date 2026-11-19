# 连接器与执行器施工清单

候选快照：2026-11-19。没有在 SourceQuest 中实现或验收这些新增适配；版本、认证和许可在实际引入时重新核对并锁定。

这里的“全部融合”指统一能力目录、策略、任务与证据协议。每个发行版本维护实际支持表；同类候选可以作为替换实现，默认项通过测试选定，不能把登记清单当成全量安装清单。

## 1. 首发必需路径

| 能力 | 任务 | 实现入口 | 验收边界 |
|---|---|---|---|
| 普通搜索与融合 | SQ-030/031 | 宿主 ctx.web；存在 Web Search Manager 时复用 | 不要求固定三家来源；不覆盖既有管理器；状态/预算可见 |
| 已知 URL 读取 | SQ-032 | 宿主 fetch 与已配置的读取来源 | 不改写请求约束；有 MIME/质量/定位与失败状态 |
| 模型 | SQ-033/034 | 宿主 LLM；可选 Magpie 适配 | 不依赖个人模型组；Schema/取消/上下文通过 |
| 任务与证据 | SQ-020–024/051 | 原生 jobs + 持久任务/产物 | 同一任务可追溯，取消/恢复/所有者检查通过 |

v0.1 用测试宿主实际配置的来源完成验收，不替所有用户开启某供应商或订阅。

## 2. 搜索与专题连接器

| 候选 | 施工归属 | 接入原则与所需条件 |
|---|---|---|
| Tavily / DeepSeek / DDG | SQ-030/031 | 已有宿主/管理器适配优先，保留来源开关、凭据与计费语义 |
| Exa / Brave / 博查 / Serper / Zhipu 等 | SQ-070 | 先发现当前已有适配；按实际认证/额度启用，避免另装重复驱动 |
| [SearXNG](https://github.com/searxng/searxng) 与 [DSH adapter](https://github.com/chinng-inta/dsh-web-search-searxng) | SQ-070 | 需要可用实例和 JSON；bundle 默认选择行为需适配，不能接管用户全局设置 |
| [fangchenghao 搜索插件](https://github.com/fangchenghao/dsh-web-search) | SQ-070 | 评估定向站点/平台查询；其聚合路线作为不透明来源时标注真实已知下游，不重复并发底层源 |
| [wwskills 百度适配](https://github.com/wwskills/dsh-web-search-providers) | SQ-070 | 主要补中文入口；凭据、SDK/Cordis 范围与现有 provider ID 冲突需先检查 |
| [Nature Academic Search](https://github.com/wp-a/nature-academic-search)、[dsh-lit-search](https://github.com/Flan246/dsh-lit-search) | SQ-070 | 作为论文能力的候选实现对照，区分元数据/摘要/全文，保留 DOI 等实体标识 |
| [dsh-ai4scholar](https://github.com/literaf/dsh-ai4scholar) | SQ-070 | 可选服务连接器；认证与全文权限按后端服务，不能宣称本地直连所有数据库 |
| [GitHub 官方 MCP](https://github.com/github/github-mcp-server) / API | SQ-070 | 限于实际授权的数据，记录仓库、提交/版本和代码定位 |
| Context7 / 官方文档 | SQ-070 | 复用已配置能力，核对库和文档版本；不要求额外开启重复 MCP 管理器 |
| Grok Build / X | SQ-070 | 检测到已配置工具时使用；明确公开可访问/索引覆盖，不假冒原生完整 X API |
| 知乎、其他站点与 RSS | SQ-070 | 按来源单独验收；持续监控/定时采集只在用户明确要求时创建 |

论文源身份、字段与引用计数分别保留；搜索结果日期不能自动当成已核实发布日期。来源健康状态取实际检查时间，未知状态不会伪装为健康。

## 3. 抓取、浏览器与解析执行器

| 候选 | 任务 | 准入标准 |
|---|---|---|
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | SQ-071 | 按需独立 runtime；页数/深度/域/时间/取消可控；默认先验证非 LLM 提取 |
| [Crawlee](https://github.com/apify/crawlee) | SQ-071/076 | 确有批量需求后评估持久 URL 队列；一个任务只有一个队列调度所有者 |
| [Scrapling](https://github.com/D4Vinci/Scrapling) / [Spider](https://github.com/spider-rs/spider) | SQ-071/076 | 特定站点/吞吐替换候选，相同任务预算对照后才改变默认 |
| [Trafilatura](https://github.com/adbar/trafilatura) | SQ-032/072 | 已有 HTML 的正文提取候选；保留原始/归一化版本和定位，不重复下载同一页 |
| [Docling](https://github.com/docling-project/docling) | SQ-072 | 对照既有 PDF/文档工具，页码、表格/OCR准确性与资源占用需要实测 |
| Playwright MCP | SQ-073 | 优先复用已有配置；会话锁、任务范围取消、截图/附件与登录状态隔离 |
| [Browser Use](https://github.com/browser-use/browser-use) / [Stagehand](https://github.com/browserbase/stagehand) | SQ-073 | 先验证本地浏览器、自有模型网关、工具/Schema/图片协议，再同题选择默认执行器 |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | SQ-073 | CLI/快照路线候选；元素引用随页面变化重取，子进程与 idle 生命周期受控 |
| [原生 DSH 浏览器](https://github.com/wqty123/dsh-browser) | SQ-073 | 验证 rc.5 UI、认证、附件和人工接管路径；不与其他执行器争用同一 profile |
| [Lightpanda](https://github.com/lightpanda-io/browser) | SQ-073/076 | 实验浏览器后端；不作为图形/截图能力的等价替代，兼容与收益在本机测量 |
| [Firecrawl](https://github.com/firecrawl/firecrawl) | SQ-071/076 | 本地/托管能力与费用分开，作为可选执行器，不隐式触发新服务 |
| [ScrapeGraphAI](https://github.com/ScrapeGraphAI/Scrapegraph-ai) | SQ-072/075 | 语义提取候选；与现有模型 Schema 抽取比较收益与消耗 |

首期 browser 并发与资源上限从保守值开始，在隔离环境调整。执行器输出相同的 evidence/artifact/receipt；不向 core 泄漏某框架专用状态。

## 4. 证据与研究组件

- [REP core](https://github.com/PerryLink/dsh-research-core)：SQ-024/074 的证据互通候选，先做版本和定位往返测试。
- [研究报告组件](https://github.com/PerryLink/dsh-research-report)：SQ-074/076 的可选封存能力；哈希/字面核验与语义真实性分开。
- 研究循环参考应核对准确仓库、版本、SDK API 与许可证；旧的 `ctx.workflows` 不能直接等同于当前 `workflowEngine`。固定预设的研究工具也不能直接视为在所有会话可见。

## 5. 每个连接器的交付清单

- [ ] 来源仓库、包名、实际锁定版本/提交、许可证和再分发边界。
- [ ] 能力、支持的约束、认证引用、upstreamFamily、计费/未知项。
- [ ] 取消、超时、重试/冷却、输出截断和预算行为。
- [ ] 结果规范化、引用定位、缓存身份与失败语义。
- [ ] fixture 契约、隔离宿主加载、获准范围的真实调用记录。
- [ ] 主包缺少该组件时的降级、卸载和数据保留规则。
- [ ] 更新实际支持表和已知限制；未测能力保持 candidate/unsupported。
