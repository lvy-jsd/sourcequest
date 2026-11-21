# 公开一手来源评测

SQ-010–012 的第一批真实来源题集用固定 URL 测正文获取、引文定位和参考要点覆盖。基线包含六个问题，覆盖 HTTP、爬虫协议、规范关键词、数据编码和 Node.js 版本文档。[题集](../benchmark/public-source-cases.mjs) · [执行器](../benchmark/public-evaluation.mjs)

## 运行方式

```sh
npm ci
npm test
npm run benchmark:public --silent
```

默认使用合成短文本，适合反复核查判分。显式在线模式逐题读取公开 URL，每题一次逻辑读取，沿用探原的出站策略、单步超时和正文限制。该模式不调用搜索 API 或模型，不需要账号或凭据。

```sh
npm run benchmark:public:live --silent
node benchmark/public-evaluation.mjs --live --only json-public-encoding
```

JSON 由标准输出生成，退出码 0 表示所选题全通过，1 表示有失败，2 表示 CLI 参数或配置有误。报告记录版本、模式、运行时间、逐题耗时、逻辑调用和失败类型，不输出已读取的全文、引文或快照。在线传输次数含重定向，当前读适配器没有逐请求账本，报告中记为未知。

## 判分与边界

每题分别核查最终来源、快照散列及字符偏移、参考要点。来源比较去掉 URL 片段，要求请求和最终证据均来自所标注页面。引文需能在实际读取的快照逐字复现，并在同一引文覆盖手工选定的参考要点。报告同时检查完整快照是否覆盖要点，以区分正文提取缺失与引文选段偏差。报告保留外网失败与引文不匹配；需要人工根据参考章节复核误判。

固定 URL 评测跳过搜索发现，测得的是读取和引文定位表现。它不衡量搜索召回、排序、信源交叉核验或多步骤研究。公开题集与留出题分别维护，计划中的 50 题与完整对照评测继续推进。[验收计划](ACCEPTANCE.md#3-50-题真实任务集)

## 参考材料

- robots.txt 规则与访问授权。[RFC 9309 §1](https://www.rfc-editor.org/rfc/rfc9309.html#section-1)
- HTTP 429 与可选等待提示。[RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)
- 规范关键词的大写写法。[RFC 8174 §2](https://www.rfc-editor.org/rfc/rfc8174.html#section-2)
- JSON 互操作的字符编码。[RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259.html#section-8.1)
- CBOR 设计目标。[RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html#abstract)
- Node.js HTTPS 模块的固定版本。[Node.js 22.13.0 HTTPS](https://nodejs.org/download/release/v22.13.0/docs/api/https.html#https)

## 首次在线结果

2026-11-20 使用 Node.js v24.13.0，在开发环境中执行六次逻辑读取。六题均成功读取预期页面且引文可定位，五题引文覆盖参考要点。CBOR 题的规范化快照包含所需信息，引文却没有完整覆盖参考要点，作为选段质量的已知问题保留。[CBOR 规范](https://www.rfc-editor.org/rfc/rfc8949.html#abstract)

后续已在 `citation()` 引入跨行滑窗、IDF 与邻接二元词组打分，并在离线多行回归测试中验证 CBOR 摘要选段覆盖；`--live` 在线复跑尚待在有公网核验条件的环境中执行。
