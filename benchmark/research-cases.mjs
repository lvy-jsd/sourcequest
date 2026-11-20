const root = "https://example.com";
const a = `${root}/a`;
const b = `${root}/b`;
const c = `${root}/c`;
const d = `${root}/d`;
const old = `${root}/doc?v=1`;
const current = `${root}/doc?v=2`;
const body = "Release notes\nThe tool registry disposes registrations when the plugin unloads.";
const zh = "发布说明\n插件卸载时释放工具注册，并保留证据快照。";

export const cases = [
  {
    id: "lookup-primary-source",
    input: { queries: ["registry disposal"] },
    search: { "registry disposal": [a] },
    pages: { [a]: body },
    expect: { status: "completed", sources: [a], reads: [a], evidence: [a], quote: "disposes registrations" },
  },
  {
    id: "isolate-provider-failure",
    input: { queries: ["temporarily offline", "primary documentation"] },
    search: { "temporarily offline": "SEARCH_FAILED", "primary documentation": [a] },
    pages: { [a]: body },
    expect: { status: "partial", sources: [a], reads: [a], evidence: [a], issues: ["SEARCH_FAILED"] },
  },
  {
    id: "preserve-version-parameters",
    input: { urls: [`${current}#results`], queries: ["all versions"] },
    search: { "all versions": [old, `${current}#toc`] },
    pages: { [old]: "Previous version results.", [current]: body },
    expect: { status: "completed", sources: [old, current], reads: [current, old], evidence: [current, old] },
  },
  {
    id: "reject-private-and-cleartext-targets",
    input: { urls: ["https://127.0.0.1/", "http://example.com/"] },
    expect: { status: "failed", issues: ["INVALID_REQUEST", "INVALID_REQUEST"] },
  },
  {
    id: "no-results-is-not-success",
    input: { queries: ["nothing indexed"] },
    search: { "nothing indexed": [] },
    expect: { status: "failed", issues: ["EMPTY_RESULT"] },
  },
  {
    id: "respect-read-budget",
    input: { urls: [a, b, c], queries: ["candidate overflow"] },
    search: { "candidate overflow": [d] },
    pages: { [a]: body, [b]: "Second source.", [c]: "Third source." },
    expect: { status: "completed", sources: [d], reads: [a, b, c], evidence: [a, b, c], omitted: 1 },
  },
  {
    id: "deduplicate-redirect-destinations",
    input: { urls: [a, b] },
    pages: { [a]: { finalUrl: c, text: body }, [b]: { finalUrl: c, text: body } },
    expect: { status: "completed", reads: [a, b], evidence: [c] },
  },
  {
    id: "keep-candidate-when-reading-is-denied",
    input: { queries: ["restricted source"] },
    search: { "restricted source": [d] },
    pages: { [d]: { error: "AUTH_REQUIRED" } },
    expect: { status: "partial", sources: [d], reads: [d], issues: ["AUTH_REQUIRED"] },
  },
  {
    id: "locate-chinese-evidence",
    input: { urls: [a], focus: "证据快照" },
    pages: { [a]: zh },
    expect: { status: "completed", reads: [a], evidence: [a], quote: "保留证据快照" },
  },
  {
    id: "reject-an-empty-page-with-a-candidate",
    input: { queries: ["empty page"] },
    search: { "empty page": [b] },
    pages: { [b]: "" },
    expect: { status: "partial", sources: [b], reads: [b], issues: ["UNUSABLE_BODY"] },
  },
];
