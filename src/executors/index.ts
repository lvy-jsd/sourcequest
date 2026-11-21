import { publicHttpsUrl, readPublicHttps } from "../adapters/public-https.js";
import { snapshotHash } from "../core/snapshot-store.js";
import type {
  BatchExecutorPort,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserPort,
  ExecutorItemOutcome,
  ExecutorManifest,
  ExecutorRunResult,
  PortCallContext,
} from "../ports/index.js";

export const BROWSER_COMPARISON_MATRIX = [
  {
    id: "playwright",
    license: "Apache-2.0",
    jsRendering: true,
    profileLockAware: true,
    ssrfGuard: "enforced-before-goto",
    status: "default-candidate",
  },
  {
    id: "stagehand",
    license: "MIT",
    jsRendering: true,
    profileLockAware: true,
    ssrfGuard: "wrapper-required",
    status: "candidate",
  },
  {
    id: "agent-browser",
    license: "Apache-2.0",
    jsRendering: true,
    profileLockAware: false,
    ssrfGuard: "wrapper-required",
    status: "candidate",
  },
  {
    id: "lightpanda",
    license: "AGPL-3.0",
    jsRendering: true,
    profileLockAware: false,
    ssrfGuard: "readonly-js-comparison",
    status: "experimental-readonly",
  },
] as const;

function validateManifestUrls(manifest: ExecutorManifest): { valid: boolean; reason?: string } {
  for (const item of manifest.items) {
    let parsed: URL;
    try {
      parsed = publicHttpsUrl(item.url);
    } catch {
      return { valid: false, reason: `Item ${item.itemId} failed public HTTPS SSRF validation.` };
    }
    if (manifest.allowedDomains && manifest.allowedDomains.length > 0) {
      const host = parsed.hostname.toLowerCase();
      const allowed = manifest.allowedDomains.some(
        (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`),
      );
      if (!allowed) {
        return { valid: false, reason: `Item ${item.itemId} domain ${host} is outside allowedDomains.` };
      }
    }
  }
  return { valid: true };
}

export class Crawl4AiExecutor implements BatchExecutorPort {
  readonly id = "crawl4ai";
  readonly supportedJobTypes = ["snapshot", "batch"] as const;
  readonly supportsResume = true;

  constructor(
    private readonly runner?: (
      url: string,
      maxDepth: number,
      signal: AbortSignal,
    ) => Promise<{ text: string; links: readonly string[] }>,
  ) {}

  async execute(
    manifest: ExecutorManifest,
    priorOutcomes: ReadonlyMap<string, ExecutorItemOutcome>,
    ctx: PortCallContext,
  ): Promise<ExecutorRunResult> {
    ctx.signal.throwIfAborted();
    const check = validateManifestUrls(manifest);
    if (!check.valid) {
      return {
        executorId: this.id,
        jobType: manifest.jobType,
        outcomes: manifest.items.map((item) => ({
          itemId: item.itemId,
          status: "failed",
          errorCode: "INVALID_REQUEST",
          summary: check.reason,
        })),
        limitations: [check.reason!],
        cleanedUp: true,
      };
    }

    const maxPages = Math.min(manifest.maxPages ?? 10, 50);
    const maxDepth = Math.min(manifest.maxDepth ?? 2, 4);
    const outcomes: ExecutorItemOutcome[] = [];
    const limitations: string[] = [];

    for (const item of manifest.items.slice(0, maxPages)) {
      ctx.signal.throwIfAborted();
      const prev = priorOutcomes.get(item.itemId);
      if (prev?.status === "verified" || prev?.status === "skipped_verified") {
        outcomes.push({ ...prev, status: "skipped_verified" });
        continue;
      }
      try {
        if (this.runner) {
          const out = await this.runner(item.url, maxDepth, ctx.signal);
          const digest = snapshotHash(out.text);
          outcomes.push({
            itemId: item.itemId,
            status: "verified",
            sha256: digest,
            bytes: Buffer.byteLength(out.text),
            summary: `Crawled ${out.links.length} link(s) within depth ${maxDepth}.`,
          });
        } else {
          const page = await readPublicHttps(item.url, ctx.signal);
          const digest = snapshotHash(page.text);
          outcomes.push({
            itemId: item.itemId,
            status: "verified",
            sha256: digest,
            bytes: Buffer.byteLength(page.text),
            summary: "Fallback static HTTPS extraction used (Crawl4AI worker offline).",
          });
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        outcomes.push({
          itemId: item.itemId,
          status: "failed",
          errorCode: "UNUSABLE_BODY",
          summary: "Crawl item failed.",
        });
      }
    }

    if (!this.runner) {
      limitations.push("Crawl4AI external Python worker was not attached; bounded static HTTPS fallback ran.");
    }
    return {
      executorId: this.id,
      jobType: manifest.jobType,
      outcomes,
      limitations,
      cleanedUp: true,
    };
  }
}

export class DocumentParserExecutor implements BatchExecutorPort {
  readonly id = "pdf-ocr";
  readonly supportedJobTypes = ["snapshot", "batch"] as const;
  readonly supportsResume = true;
  readonly parserVersion = "sourcequest-doc-v1";

  constructor(
    private readonly parseImpl?: (
      url: string,
      signal: AbortSignal,
    ) => Promise<{
      pages: { page: number; text: string; tables?: string[][] }[];
      hasFormulas?: boolean;
      ocrUsed?: boolean;
    }>,
  ) {}

  async execute(
    manifest: ExecutorManifest,
    priorOutcomes: ReadonlyMap<string, ExecutorItemOutcome>,
    ctx: PortCallContext,
  ): Promise<ExecutorRunResult> {
    ctx.signal.throwIfAborted();
    const check = validateManifestUrls(manifest);
    if (!check.valid) {
      return {
        executorId: this.id,
        jobType: manifest.jobType,
        outcomes: manifest.items.map((item) => ({
          itemId: item.itemId,
          status: "failed",
          errorCode: "INVALID_REQUEST",
          summary: check.reason,
        })),
        limitations: [check.reason!],
        cleanedUp: true,
      };
    }

    const outcomes: ExecutorItemOutcome[] = [];
    const limitations: string[] = [];

    for (const item of manifest.items) {
      ctx.signal.throwIfAborted();
      const prev = priorOutcomes.get(item.itemId);
      if (prev?.status === "verified" || prev?.status === "skipped_verified") {
        outcomes.push({ ...prev, status: "skipped_verified" });
        continue;
      }
      if (!this.parseImpl) {
        outcomes.push({
          itemId: item.itemId,
          status: "unsupported",
          errorCode: "UNSUPPORTED_MIME",
          summary: "PDF/OCR binary runtime (Docling/poppler/tesseract) is not attached.",
        });
        limitations.push(`Document ${item.itemId} marked unsupported: external PDF/OCR runtime missing.`);
        continue;
      }
      try {
        const parsed = await this.parseImpl(item.url, ctx.signal);
        const joined = parsed.pages.map((p) => `[Page ${p.page}]\n${p.text}`).join("\n");
        outcomes.push({
          itemId: item.itemId,
          status: "verified",
          sha256: snapshotHash(joined),
          bytes: Buffer.byteLength(joined),
          summary: `Parsed ${parsed.pages.length} page(s) with ${this.parserVersion} (ocr=${Boolean(parsed.ocrUsed)}).`,
        });
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        outcomes.push({
          itemId: item.itemId,
          status: "failed",
          errorCode: "UNUSABLE_BODY",
          summary: "PDF/OCR parser failed.",
        });
      }
    }

    return {
      executorId: this.id,
      jobType: manifest.jobType,
      outcomes,
      limitations,
      cleanedUp: true,
    };
  }
}

export class BrowserExecutor implements BrowserPort {
  readonly id = "playwright";
  private profileBusy = false;

  constructor(
    private readonly driver?: (req: BrowserActionRequest, ctx: PortCallContext) => Promise<BrowserActionResult>,
  ) {}

  async browse(req: BrowserActionRequest, ctx: PortCallContext): Promise<BrowserActionResult> {
    ctx.signal.throwIfAborted();
    const safeUrl = publicHttpsUrl(req.url);
    if (req.allowedDomains && req.allowedDomains.length > 0) {
      const host = safeUrl.hostname.toLowerCase();
      if (!req.allowedDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`))) {
        throw new Error(`Browser domain ${host} is outside allowedDomains.`);
      }
    }
    if (this.profileBusy) {
      throw new Error("Isolated browser profile lock is already held by an active run.");
    }
    if (!this.driver) {
      throw new Error("Playwright/Chrome browser runtime is not attached in this execution context.");
    }
    this.profileBusy = true;
    try {
      return await this.driver({ ...req, url: safeUrl.href }, ctx);
    } finally {
      this.profileBusy = false;
    }
  }
}

export class ResumableBatchQueueExecutor implements BatchExecutorPort {
  readonly id = "batch-queue";
  readonly supportedJobTypes = ["snapshot", "batch", "subscription"] as const;
  readonly supportsResume = true;

  constructor(
    private readonly fetcher?: (
      item: ExecutorManifest["items"][number],
      signal: AbortSignal,
    ) => Promise<{ bytes: Uint8Array; verifiedTitle?: string; metadata?: Record<string, unknown> }>,
  ) {}

  async execute(
    manifest: ExecutorManifest,
    priorOutcomes: ReadonlyMap<string, ExecutorItemOutcome>,
    ctx: PortCallContext,
  ): Promise<ExecutorRunResult> {
    ctx.signal.throwIfAborted();
    const check = validateManifestUrls(manifest);
    if (!check.valid) {
      return {
        executorId: this.id,
        jobType: manifest.jobType,
        outcomes: manifest.items.map((item) => ({
          itemId: item.itemId,
          status: "failed",
          errorCode: "INVALID_REQUEST",
          summary: check.reason,
        })),
        limitations: [check.reason!],
        cleanedUp: true,
      };
    }

    const outcomes: ExecutorItemOutcome[] = [];
    const limitations: string[] = [];

    for (const item of manifest.items) {
      ctx.signal.throwIfAborted();
      const prev = priorOutcomes.get(item.itemId);
      if (prev?.status === "verified" || prev?.status === "skipped_verified") {
        // Never re-download an already integrity-verified batch item on resume.
        outcomes.push({ ...prev, status: "skipped_verified" });
        continue;
      }

      if (!this.fetcher) {
        outcomes.push({
          itemId: item.itemId,
          status: prev?.status === "outcome_unknown" ? "outcome_unknown" : "unsupported",
          errorCode: "NOT_CONFIGURED",
          summary: `Batch resource downloader for ${manifest.resourceKind} is not attached.`,
        });
        limitations.push(`External runtime required for ${manifest.resourceKind} (${item.itemId}).`);
        continue;
      }

      try {
        const downloaded = await this.fetcher(item, ctx.signal);
        const actualSha256 = snapshotHash(downloaded.bytes);
        const actualBytes = downloaded.bytes.byteLength;
        if (item.expectedSha256 && actualSha256 !== item.expectedSha256) {
          outcomes.push({
            itemId: item.itemId,
            status: "failed",
            sha256: actualSha256,
            bytes: actualBytes,
            errorCode: "STORAGE_FAILED",
            summary: `Checksum mismatch for ${item.itemId}.`,
          });
          continue;
        }
        if (item.expectedBytes !== undefined && actualBytes !== item.expectedBytes) {
          outcomes.push({
            itemId: item.itemId,
            status: "failed",
            sha256: actualSha256,
            bytes: actualBytes,
            errorCode: "STORAGE_FAILED",
            summary: `Byte size mismatch for ${item.itemId}: expected ${item.expectedBytes}, got ${actualBytes}.`,
          });
          continue;
        }
        outcomes.push({
          itemId: item.itemId,
          status: "verified",
          sha256: actualSha256,
          bytes: actualBytes,
          summary: `Verified ${manifest.resourceKind} artifact (${actualBytes} bytes).`,
        });
      } catch (error) {
        if (ctx.signal.aborted) {
          outcomes.push({
            itemId: item.itemId,
            status: "outcome_unknown",
            errorCode: "CANCELLED",
            summary: "Cancelled during transfer; outcome unknown until re-checked.",
          });
          throw error;
        }
        outcomes.push({
          itemId: item.itemId,
          status: "failed",
          errorCode: "UNUSABLE_BODY",
          summary: `Transfer failed for ${item.itemId}.`,
        });
      }
    }

    return {
      executorId: this.id,
      jobType: manifest.jobType,
      outcomes,
      limitations,
      cleanedUp: true,
    };
  }
}

export function planAcademicDatasetExecution(manifest: ExecutorManifest): {
  rawArtifacts: readonly string[];
  layoutEvidenceItems: readonly string[];
  parsedArtifacts: readonly string[];
  pinnedRevisionsPresent: boolean;
} {
  return {
    rawArtifacts: manifest.items.map((i) => `raw:${i.itemId}`),
    layoutEvidenceItems: manifest.items.map((i) => `layout:${i.itemId}`),
    parsedArtifacts: manifest.items.map((i) => `parsed:${i.itemId}`),
    pinnedRevisionsPresent: manifest.items.every((i) => Boolean(i.version)),
  };
}
