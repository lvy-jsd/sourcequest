# 项目目标与施工交接

更新于 2026-11-21（Australia/Perth）。

**目标**是把探原做成独立开源的 DSH 原生网络研究与资源获取插件。用户在现有会话发起任务，探原自动选择来源、模型与执行器，交付能定位到原文的证据，以及能取消和恢复的后台任务。关键事实正确性、原文支撑率、任务完成度、恢复结果、延迟与成本通过同题评测衡量。后续 MCP 和 CLI 复用同一核心。

## 当前进度

| 项目 | 状态 | 证据与接手点 |
|---|---|---|
| 施工计划 v1.3 | 已记录 | [46 项施工任务](IMPLEMENTATION_PLAN.md)列出依赖与验收条件。 |
| SQ-001 · DSH SDK | 首期验收通过 | 已核对 DSH 0.2.2-rc.5 / Cordis 4.1.0 的发行类型，使用锁定包编译并实测工具接口。持久化、认证与模型按各自里程碑验证。[勘验记录](COMPATIBILITY.md) |
| SQ-002 · 数据契约 | 已完成核心契约 | 已补齐任务身份、多维预算、币种成本、`Source`/`Snapshot`/`Anchor`/`Evidence`/`Claim`/`Coverage`、三层 `RoutingDecision`、完整 `net_research` 请求协议与不可降级 `migrateTaskRecord` 迁移校验，见 [contracts.ts](../src/core/contracts.ts) 与 [ports/index.ts](../src/ports/index.ts)。 |
| SQ-003 · 最小 Bundle | 已验收 | TypeScript、依赖锁文件与 CI 配置已提交。隔离 Web profile 安装后经真实 DSH 执行诊断，移除重启后工具消失；`npm pack` 构建包结构已验证。 |
| SQ-004 / SQ-031 / SQ-034 / SQ-035 · 能力、路由与缓存退避 | 已实现并经单元/B1-B22测试通过 | 已实现 `CapabilityRegistry`、`ThreeTierRouter`（硬约束→资源可行性→策略排序→决策记录）、`HostBackoffTracker`、`ResponseCache`（owner/authContext 隔离）与同源族/内容散列去重。 |
| SQ-032 / SQ-033 · 正文质量分流与 `LlmPort` | 已实现（离线/适配测试通过） | `triageReadPage` 已区分短公告、JS 空壳、长登录墙、429 与 PDF/二进制；`DshLlmAdapter` 已对接 `@deepseek-ai/dsh-llm` 流式契约与结构化 JSON 解析，支持无 Magpie 运行与宿主模型归属记录。 |
| SQ-040–044 · G4 有预算研究闭环 | 已实现并经闭环与 50 题验证 | 已实现 `buildResearchPlan`、`runBoundedResearchLoop`、`BudgetLedger`（并发/多维预留/未知成本拦截）与 `verifyWithCounterEvidence`；无原文支撑自动降级为 `unknown`/`inference`，达预算/轮次保留未解决问题为 `partial`。 |
| SQ-020–024 / SQ-050–054 · DSH 原生产品化（G5） | 已实现（隔离 DSH Cordis 自动化测试通过） | `net_research` 兼容预览入参并支持 `goal`/`strategy`/`constraints`/`overrides` 研究循环；`net_job` 补齐 `list` 分页、`expectedRevision` 及从 `interrupted`/`partial`/`failed` 恢复；`SnapshotStore` 新增二进制 Artifact、显式删除与孤儿 GC；`ExplicitDshWebBridge` 含 `AsyncLocalStorage` 防递归；已补齐 `SourceQuestRpcService`、`renderSourceQuestPanelHtml` 面板视图与 `sourcequest_doctor` 诊断（真实浏览器点击与远程认证流待实测）。 |
| SQ-010–012 / SQ-060–063 · 评测与 B1–B22 验收（G6） | 离线基线与 52+2 自动化测试通过 | `npm test`（52/52，含 `acceptance-b1-b22.test.mjs` 与 `g2-g7-complete.test.mjs`）、`npm run test:e2e`（2/2）、10 题离线基线、6 题公开源离线基线与 50 题分层评测（开发 30/30、留出 20/20，10 题未支持能力如实计入分母且标为 `unsupported`）全部通过；真实在线评测（需外部搜索凭据/预算）按规范不自动触发。 |
| SQ-070–079 · G7 专题连接器与十类前沿资源引擎 | 已融合内核与 61 项单测通过；外部运行时/凭据项标记受阻/待实测 | 已实现 `CorpusIndex`（BM25+混合重排对比）、`generateDeepRecoveryReport`、`arXiv`/`OpenAlex`/`cn-feeds` 连接器、`Crawl4AiExecutor`、`DocumentParserExecutor`、`BrowserExecutor`、`ResumableBatchQueueExecutor`，以及融合十类前沿资源能力的 [frontier-resources.ts](../src/executors/frontier-resources.ts)（Trafilatura/Defuddle 网页 Markdown 与 JSON-LD 提取、`lncrawl`/Legado 连载规则探测与断章校验、HLS `.m3u8` + WebVTT/SRT 字幕锚定 + `yt-dlp` 探测、HTTP Range 断点续传与多卷校验、ISRC + LRC 歌词对齐、图集/漫画原图与缩略图分层及 `ComicInfo.xml`、学术论文公式与跨页表格、`Streamlink` 直播滑窗空窗标注、Podcast RSS 2.0 解析）和 `<think>` 兼容 JSON 解析（`parseStructuredJson`），暴露统一入口 `resource_acquire`。需外部账号凭据或未装本地二进制的执行器（`x-search`、Telegram/Discord/Feishu/Notion、Streamlink/gallery-dl/Docling/OCR 实机二进制）已按 `AGENTS.md` 如实标记为受阻/未实测。 |

**当前状态**：G3–G7 核心架构、DSH 原生适配、G7 连接器/执行器与 52 项单测 + 2 项 E2E + 50 题分层评测全部通过；仅剩需个人外部账号凭据或重型本地二进制的第三方在线验收留待目标运行环境按需补充（见 [ACCEPTANCE.md](ACCEPTANCE.md)）。下一步如推进跨端可接手 G8（MCP/CLI）。

## GitHub 同步约定

- GitHub 的 `main` 保存已同步的计划和交接状态。接手前核对当前提交和任务分支，避免重复施工。
- 开始任务、遇到阻塞、验证通过或移交时更新本页。同一次变更尽量带上实现、验证记录和交接状态，并及时提交到 GitHub。
- 并行未完成的实现可推到任务分支。本页记录任务 ID、分支或证据链接、已验证内容和下一步。其他贡献者可从分支继续，或通过提交历史复查。
- 已验证的状态与预期行为分别标记。公开记录使用合成数据或脱敏材料。

[验收与评测标准](ACCEPTANCE.md) · [架构](ARCHITECTURE.md) · [阶段路线图](ROADMAP.md)
