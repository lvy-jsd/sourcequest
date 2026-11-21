export type CorpusDocument = {
  id: string;
  title: string;
  text: string;
  url?: string;
  publishedAt?: string;
  sourceTier?: "primary" | "secondary" | "archive";
};

export type CorpusScoredHit = {
  id: string;
  title: string;
  bm25Score: number;
  hybridScore: number;
  matchedTerms: readonly string[];
  excerpt: string;
};

export type StrategyComparisonReport = {
  query: string;
  bm25TopIds: readonly string[];
  hybridTopIds: readonly string[];
  bm25AvgScore: number;
  hybridAvgScore: number;
  rerankedOrderChanged: boolean;
};

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const asciiWords = lower.match(/[a-z0-9_.-]+/gu) ?? [];
  const cjkChars = [...lower].filter((ch) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch));
  const cjkBigrams: string[] = [];
  for (let i = 0; i + 1 < cjkChars.length; i++) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }
  return [...asciiWords, ...cjkChars, ...cjkBigrams];
}

function extractBestExcerpt(text: string, queryTerms: readonly string[]): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= 280) return clean;
  const lower = clean.toLowerCase();
  for (const term of queryTerms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      return clean.slice(start, Math.min(clean.length, start + 280));
    }
  }
  return clean.slice(0, 280);
}

export class CorpusIndex {
  private readonly docs: CorpusDocument[] = [];
  private readonly docTokens = new Map<string, Map<string, number>>();
  private readonly docLengths = new Map<string, number>();
  private readonly docFreq = new Map<string, number>();
  private avgDocLength = 0;

  addDocuments(documents: readonly CorpusDocument[]): void {
    for (const doc of documents) {
      this.docs.push(doc);
      const tokens = tokenize(`${doc.title} ${doc.text}`);
      const tf = new Map<string, number>();
      for (const tok of tokens) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }
      this.docTokens.set(doc.id, tf);
      this.docLengths.set(doc.id, tokens.length);
      for (const term of tf.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    const totalLen = [...this.docLengths.values()].reduce((acc, v) => acc + v, 0);
    this.avgDocLength = this.docs.length > 0 ? totalLen / this.docs.length : 1;
  }

  searchBm25(query: string, topK = 5): CorpusScoredHit[] {
    const qTerms = [...new Set(tokenize(query))];
    const k1 = 1.5;
    const b = 0.75;
    const n = Math.max(1, this.docs.length);

    const scored: CorpusScoredHit[] = [];
    for (const doc of this.docs) {
      const tf = this.docTokens.get(doc.id)!;
      const dl = Math.max(1, this.docLengths.get(doc.id) ?? 1);
      let bm25 = 0;
      const matched: string[] = [];
      for (const term of qTerms) {
        const freq = tf.get(term) ?? 0;
        if (!freq) continue;
        matched.push(term);
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const num = freq * (k1 + 1);
        const den = freq + k1 * (1 - b + b * (dl / Math.max(1, this.avgDocLength)));
        bm25 += idf * (num / den);
      }
      if (bm25 > 0) {
        scored.push({
          id: doc.id,
          title: doc.title,
          bm25Score: Number(bm25.toFixed(4)),
          hybridScore: Number(bm25.toFixed(4)),
          matchedTerms: matched,
          excerpt: extractBestExcerpt(doc.text, matched),
        });
      }
    }
    scored.sort((a, bScore) => bScore.bm25Score - a.bm25Score);
    return scored.slice(0, topK);
  }

  searchHybrid(query: string, topK = 5): CorpusScoredHit[] {
    const base = this.searchBm25(query, Math.max(topK * 3, 15));
    const qLower = query.toLowerCase();
    const docMap = new Map(this.docs.map((d) => [d.id, d]));

    const reranked = base.map((hit) => {
      const doc = docMap.get(hit.id)!;
      let boost = 1.0;
      if (doc.title.toLowerCase().includes(qLower)) boost += 0.35;
      if (doc.sourceTier === "primary") boost += 0.25;
      if (doc.publishedAt && doc.publishedAt >= "2026-01-01") boost += 0.1;
      const phraseBonus = doc.text.toLowerCase().includes(qLower) ? 0.3 : 0;
      return {
        ...hit,
        hybridScore: Number((hit.bm25Score * boost + phraseBonus).toFixed(4)),
      };
    });
    reranked.sort((a, b) => b.hybridScore - a.hybridScore);
    return reranked.slice(0, topK);
  }

  compareStrategies(query: string, topK = 5): StrategyComparisonReport {
    const bm25 = this.searchBm25(query, topK);
    const hybrid = this.searchHybrid(query, topK);
    const bm25TopIds = bm25.map((h) => h.id);
    const hybridTopIds = hybrid.map((h) => h.id);
    const avg = (vals: number[]) => (vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : 0);
    return {
      query,
      bm25TopIds,
      hybridTopIds,
      bm25AvgScore: avg(bm25.map((h) => h.bm25Score)),
      hybridAvgScore: avg(hybrid.map((h) => h.hybridScore)),
      rerankedOrderChanged: JSON.stringify(bm25TopIds) !== JSON.stringify(hybridTopIds),
    };
  }
}
