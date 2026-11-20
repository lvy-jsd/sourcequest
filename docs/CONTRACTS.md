# 任务、路由与证据契约

设计版本 1.0。SQ-002 已实现任务状态、状态变更、预算和错误的首批校验，见 [contracts.ts](../src/core/contracts.ts)。TypeScript 类型从 Schema 推导。工具参数、证据、路由和持久化协议仍按下文设计推进。

## 1. 公共工具

### net_research

当前实现支持 `queries`、`urls` 和 `focus`。返回 `schemaVersion`、操作状态、候选来源、引文、失败项和因页面预算未读取的候选数。这里的 `completed` 指有界检索操作成功。坐标采用规范化正文的 UTF-16 偏移量，`end` 为排他边界。正文暂不持久化，后续通过 Artifact 引用保留可复查的快照。

以下是最终工具协议的请求字段：

| 字段 | 语义 |
|---|---|
| schemaVersion / clientRequestId | 协议版本与调用幂等键，幂等范围含 owner |
| goal | 用户目标，必填且有长度边界 |
| intent | auto / search / read / research；crawl/browse 为后续能力，未实现时明确拒绝 |
| urls / queries | 可选的已知输入；URL 与查询有数量/长度界限 |
| topic / constraints | 主题、时间、域、语言、版本等明确约束 |
| strategy | quick / balanced / deep，宿主配置限定上限 |
| overrides | 可选来源/模型/执行器及 allowFallback；手动选择优先 |
| budget | 在部署最大值内请求更小预算，模型参数不能抬高部署上限 |
| output | 精简证据/报告/导出偏好，不允许任意主机写出路径 |

返回 taskId、runId、status、summary、coverage、sourceRefs、artifactRefs、usage、limitations。运行未结束时返回 taskId 与已知进度；大正文通过受 owner 约束的读取/分页取回。

### net_job

动作：status / list / results / evidence / cancel / resume。输入 taskId、游标/限制、可选 expectedRevision 与 clientRequestId；list 隐式限于调用者。运行控制必须校验当前 owner，不依赖 ID 难猜。

`resume` 只恢复允许状态；默认保留剩余预算。新增预算必须是可追溯的显式操作，不能每次恢复自动重置花费。取消动作幂等，完成任务再次取消返回已终止，不抹除结果。

## 2. 稳定身份与状态

- taskId：持久研究任务，归属由宿主认证/会话建立。
- runId：一次执行/恢复的代际，每次恢复新建。
- stepId：任务内的持久步骤身份；attemptId：某步的一次尝试。
- hostJobId：可选的宿主进程内运行句柄，不承担跨重启身份。
- revision / eventSeq：变更与事件顺序，迟到代际不得覆盖新状态。

状态转换：

```text
queued → running → completed | partial | failed | cancelled
               → needs_user_action → running（明确继续）
queued/needs_user_action → cancelled（已确认无待退出的工作）
running/queued/needs_user_action → interrupted（重载/崩溃核验后）
interrupted/partial/failed → queued（可恢复、显式 resume、新 runId）
```

[状态转换函数](../src/core/task-state.ts)要求调用携带当前 runId 和 expectedRevision。存储层负责授权、分配全新 runId、保留旧运行记录与原子提交。

同一 run 的终态不可被迟到消息改写；对已终止任务恢复是新 run，保留旧结果和审计记录。`cancel_requested` 是取消传播中的控制标志，资源退出确认后才记 cancelled；不能先声称进程已停。

`completed` 表示声明范围内目标已完成；`partial` 表示有成果但预算/来源等导致缺口；`needs_user_action` 包含缺少登录或必要决定。宿主 job 的终止状态与研究完整度分别记录，不能简单一一映射。

## 3. 核心 ports

| 接口 | 输入/输出及责任 |
|---|---|
| SearchPort | 单次有约束查询→来源、摘要、执行 receipt；不支持筛选时显式拒绝 |
| ReadPort | URL 与策略→HTTP/MIME、原文/产物、质量信号、最终 URL 与 receipt |
| LlmPort | 角色、结构化输入、模态/上下文/预算→结果、实际已知模型、token 与错误；不修改全局默认 |
| BrowserPort | 有边界的页面目标→证据与操作结果；后续可选能力 |
| TaskStore | owner、版本、任务/运行/检查点、原子更新；确认写入持久后再回执 |
| ArtifactStore | 限额、owner、不可变 blob 与定位读取；校验散列、分页、回收 |
| CapabilityRegistry | capability/filter/modality/billing/upstream/状态发现；configured 不等于联网成功 |

每个执行调用都带 task/run/step/attempt 身份、取消 signal、deadline、预算许可与 owner 授权信息。worker 不接收不必要的宿主凭据。

## 4. 预算与调用账本

维度：wallTime、logicalRequests、knownBackendCalls、modelInput/OutputTokens、pages、browserSteps、bytes、并发，以及可选的 currencyLimit。

首批 Schema 用 `wallTimeMs` 表示毫秒，金额上限用三字母币种代码与最小货币单位整数表达。

处理顺序：校验→预留→持久标记开始→调用→保存结果/receipt→结算→事件。重试单独计 attempt；并发预留不能超过任务和部署上限。

金额标注 actual / estimated / unknown，并记录币种、来源和时间。逻辑搜索调用经过不透明聚合器时，不得用一次 tool call 冒充只发生一次下游请求。

硬性金额上限只对可计价且能事前约束的路线提供保证；未知计费路线在该模式拒绝或等待明确策略。其余模式可以限制时间/逻辑调用，但要披露下游花费未知。退款和提供方账单不能仅凭本地取消推定。

崩溃发生在请求发出与回执写入之间时，该尝试记 outcome_unknown；恢复不宣称外部调用从未发生，也不承诺 exactly-once 外部请求。

## 5. 证据数据

- Source：sourceId、providerId、upstreamFamily、requested/final/canonical URL、标题、可得的发布/版本信息与原始时间文本。
- Snapshot：snapshotId、来源、抓取时间、MIME、字节编码、hash、artifactRef、提取方式/版本、truncated。
- Anchor：明确定位的 snapshotId/hash、页/章节/字符范围或表格单元；定位针对 raw 或 normalized 的哪个版本必须清楚。
- Evidence：原文/摘要/元数据层级、anchor、质量与适用范围，不能只给一个 URL。
- Claim：事实/推断/未知，关联 evidenceIds、适用日期/版本、核验状态和冲突。
- Coverage：子问题及 solved/partial/unresolved、证据和未解决原因。

发布时间缺失就是未知，不以 fetchedAt 填充。归一化内容不得覆盖原始快照；解析器变化生成新版本，旧引用仍应能定位。URL 去重保留决定内容的查询参数，转载按内容处理，不因域名不同就视为独立证据。

散列与封存验证完整性，语义支持和来源真实性单独核验。REP 等协议通过 adapter 往返测试后接入，不把它们等同于自动事实认证。

## 6. 失败与缓存

错误至少区分 INVALID_REQUEST、UNSUPPORTED_CONSTRAINT、NOT_CONFIGURED、AUTH_REQUIRED、RATE_LIMITED、TIMEOUT、CANCELLED、EMPTY_RESULT、UNUSABLE_BODY、UNSUPPORTED_MIME、BUDGET_EXHAUSTED、STORAGE_FAILED、ARTIFACT_MISSING、OUTCOME_UNKNOWN。

错误含可重试性、建议等待、作用范围和安全摘要；响应正文、密钥、cookie、私有 URL 参数不进入公共日志。只对有意义的瞬态错误有限重试，调用者取消立即传播。

缓存 key 包含 owner/认证上下文、约束、提取方式/版本与内容版本；公开与账号内容隔离。精确时效请求可强制刷新。私有/登录内容不自动发送给远程提取器。

## 7. 持久化与恢复

v0.1 native 计划用宿主 storageDomain 保存小型任务/设置/检查点元数据，正文与附件由 ArtifactStore 单独管理。SQ-001 确认公开路径接口；若缺失，要求显式配置专用数据目录，不猜测个人主目录布局。

写入 artifact 后再提交引用该 artifact 的检查点；元数据失败留下的孤儿产物由保守回收清理，不能反过来把缺失 blob 标完成。保留 owner 与 run 代际，恢复时校验成果、预算、来源开关、凭据与执行器。

重试读取步骤可复用验证后的快照。浏览器恢复需要重新观察页面状态，不能盲目重放旧元素引用。删除数据是显式动作，关闭插件默认不清空证据。

## 8. 版本与迁移

schemaVersion、policyRevision、connectorVersion、parserVersion 与宿主版本进入运行记录。遇到未知新 schema 拒绝破坏性降级；迁移保留备份，失败保持原数据并提供诊断。

RPC 对跨会话读取、取消、导出与并发配置保存执行服务端校验。工具声明可见性不能替代授权检查。
