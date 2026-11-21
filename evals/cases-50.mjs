export const STRATIFICATION = {
  "software-versions": { total: 12, dev: 7, holdout: 5 },
  "architecture-selection": { total: 8, dev: 5, holdout: 3 },
  "academic-papers": { total: 10, dev: 6, holdout: 4 },
  "news-recency-controversy": { total: 10, dev: 6, holdout: 4 },
  "js-authorized-pages": { total: 5, dev: 3, holdout: 2 },
  "long-documents-pdf": { total: 5, dev: 3, holdout: 2 },
};

function makeGroup(category, devCount, holdoutCount, buildCase) {
  const cases = [];
  for (let i = 1; i <= devCount + holdoutCount; i++) {
    const split = i <= devCount ? "dev" : "holdout";
    const id = `${category}-${String(i).padStart(2, "0")}`;
    cases.push(buildCase(i, split, id));
  }
  return cases;
}

export const EVAL_CASES_50 = [
  ...makeGroup("software-versions", 7, 5, (i, split, id) => ({
    id,
    split,
    category: "software-versions",
    goal: `Verify release version v${i}.0 compatibility and migration notes`,
    queries: [`fixture package v${i}.0 release notes github`],
    urls: [],
    focus: `v${i}.0 compatibility migration`,
    constraints: { version: `v${i}.0`, domains: ["github.com", "docs.example.org"] },
    unsupportedInV01: false,
    expectedTerm: `v${i}.0`,
    mockHits: [
      { url: `https://github.com/example/pkg/releases/tag/v${i}.0`, title: `Release v${i}.0`, upstreamFamily: "github-rest-api" },
    ],
    mockDocument: `Release Notes for Package v${i}.0\nCompatibility requires Node.js 22.13 or higher. Migration steps preserve existing configuration schemas.`,
  })),
  ...makeGroup("architecture-selection", 5, 3, (i, split, id) => ({
    id,
    split,
    category: "architecture-selection",
    goal: `Compare option A vs option B architecture tradeoffs for scenario ${i}`,
    queries: [`architecture benchmark scenario ${i} primary documentation`],
    urls: [],
    focus: `tradeoffs latency memory scenario ${i}`,
    constraints: { domains: ["specs.example.org"] },
    unsupportedInV01: false,
    expectedTerm: `scenario ${i}`,
    mockHits: [
      { url: `https://specs.example.org/arch/${i}`, title: `Architecture Study ${i}`, upstreamFamily: "dsh-host-search" },
    ],
    mockDocument: `Architecture benchmark scenario ${i}: Option A optimizes cold-start latency while Option B reduces peak memory footprint under bounded concurrency.`,
  })),
  ...makeGroup("academic-papers", 6, 4, (i, split, id) => ({
    id,
    split,
    category: "academic-papers",
    goal: `Locate primary DOI citation and empirical finding for paper ${i}`,
    queries: [`scholarly paper ${i} doi empirical results`],
    urls: [],
    focus: `empirical baseline paper ${i}`,
    constraints: { dateFrom: "2024-01-01", dateTo: "2026-11-21" },
    unsupportedInV01: false,
    expectedTerm: `paper ${i}`,
    mockHits: [
      { url: `https://doi.org/10.5555/sourcequest.${i}`, title: `Paper ${i}`, upstreamFamily: "crossref-rest-api" },
    ],
    mockDocument: `Abstract for scholarly paper ${i}: Reproducible experiments across 50 stratified fixtures demonstrate higher primary citation precision.`,
  })),
  ...makeGroup("news-recency-controversy", 6, 4, (i, split, id) => ({
    id,
    split,
    category: "news-recency-controversy",
    goal: `Verify latest official statement and publication date for event ${i}`,
    queries: [`official advisory event ${i} 2026`],
    urls: [],
    focus: `official statement event ${i}`,
    constraints: { dateFrom: "2026-01-01" },
    unsupportedInV01: false,
    expectedTerm: `event ${i}`,
    mockHits: [
      { url: `https://news.example.org/advisory/${i}`, title: `Advisory ${i}`, upstreamFamily: "dsh-host-search" },
    ],
    mockDocument: `Official advisory for event ${i} published 2026-11-01: Service status restored after planned maintenance window.`,
  })),
  ...makeGroup("js-authorized-pages", 3, 2, (i, split, id) => ({
    id,
    split,
    category: "js-authorized-pages",
    goal: `Extract dynamic client-rendered or login-gated status page ${i}`,
    queries: [],
    urls: [`https://app.example.org/protected/${i}`],
    focus: `dynamic protected page ${i}`,
    constraints: {},
    unsupportedInV01: true,
    expectedTerm: "unsupported",
    mockHits: [],
    mockDocument: "",
    mockStatusCode: 403,
  })),
  ...makeGroup("long-documents-pdf", 3, 2, (i, split, id) => ({
    id,
    split,
    category: "long-documents-pdf",
    goal: `Parse multi-page PDF specification and tables for spec ${i}`,
    queries: [],
    urls: [`https://papers.example.org/spec-${i}.pdf`],
    focus: `table formula spec ${i}`,
    constraints: {},
    unsupportedInV01: true,
    expectedTerm: "unsupported",
    mockHits: [],
    mockDocument: "%PDF-1.7 binary content",
    mockMime: "application/pdf",
  })),
];
