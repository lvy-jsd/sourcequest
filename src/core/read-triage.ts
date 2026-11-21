import type { ReadPortPage } from "../ports/index.js";

export type TriageClassification =
  | "verified"
  | "shell"
  | "auth_wall"
  | "rate_limited"
  | "unsupported_mime"
  | "unusable_body";

export type TriageDecision = {
  classification: TriageClassification;
  usable: boolean;
  recommendedUpgrade?: "browser" | "doc_parser" | "user_action" | "retry_later";
  reason: string;
};

const authWallPatterns = [
  /\bsign\s*in\b/iu,
  /\blog\s*in\b/iu,
  /\blogin\s+required\b/iu,
  /\bcreate\s+an?\s+account\b/iu,
  /\bsubscribe\s+to\s+(?:read|continue)\b/iu,
  /\bmembers[- ]only\b/iu,
  /\bauthentication\s+required\b/iu,
  /请先登录|登录后查看|立即登录|订阅后继续阅读|付费墙/u,
];

const rateLimitPatterns = [
  /\btoo\s+many\s+requests\b/iu,
  /\brate\s*limit(?:ed)?\b/iu,
  /\bverify\s+you\s+are\s+human\b/iu,
  /\benable\s+cookies\s+and\s+javascript\b/iu,
  /\bchecking\s+your\s+browser\b/iu,
  /\bcloudflare\b.*\bray\s*id\b/iu,
  /访问过于频繁|人机验证|请完成验证/u,
];

const emptyShellPatterns = [
  /\byou\s+need\s+to\s+enable\s+javascript\s+to\s+run\s+this\s+app\b/iu,
  /\bplease\s+enable\s+javascript\b/iu,
  /\bjavascript\s+is\s+required\b/iu,
  /^\s*(?:loading\.{0,3}|initializing\.{0,3}|please\s+wait\.{0,3})\s*$/iu,
  /^[\s{}\[\]()<>/"':;,.-]*$/u,
];

const nonTextMimePrefixes = [
  "application/pdf",
  "image/",
  "video/",
  "audio/",
  "application/zip",
  "application/octet-stream",
];

export function triageReadPage(page: Pick<ReadPortPage, "statusCode" | "mime" | "text" | "title">): TriageDecision {
  const mime = page.mime.toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") {
    return {
      classification: "unsupported_mime",
      usable: false,
      recommendedUpgrade: "doc_parser",
      reason: "PDF documents require the PDF/OCR parser executor rather than HTML/text extraction.",
    };
  }
  if (nonTextMimePrefixes.some((prefix) => mime.startsWith(prefix))) {
    return {
      classification: "unsupported_mime",
      usable: false,
      recommendedUpgrade: "doc_parser",
      reason: `Binary or media MIME type (${mime}) requires a specialized executor.`,
    };
  }

  if (page.statusCode === 401 || page.statusCode === 403) {
    return {
      classification: "auth_wall",
      usable: false,
      recommendedUpgrade: "user_action",
      reason: `HTTP ${page.statusCode} indicates access control or login is required.`,
    };
  }
  if (page.statusCode === 429) {
    return {
      classification: "rate_limited",
      usable: false,
      recommendedUpgrade: "retry_later",
      reason: "HTTP 429 rate-limit response.",
    };
  }

  const trimmed = page.text.replace(/\s+/gu, " ").trim();
  if (!trimmed) {
    return {
      classification: "shell",
      usable: false,
      recommendedUpgrade: "browser",
      reason: "Empty extracted body likely requires client-side JS rendering.",
    };
  }

  if (rateLimitPatterns.some((re) => re.test(trimmed))) {
    return {
      classification: "rate_limited",
      usable: false,
      recommendedUpgrade: "retry_later",
      reason: "Anti-bot / rate-limit interstitial detected in response body.",
    };
  }

  // Classify long boilerplate login walls regardless of total character length.
  const wordCount = trimmed.split(/\s+/u).length;
  const authMatches = authWallPatterns.filter((re) => re.test(trimmed)).length;
  if (authMatches >= 2 || (authMatches >= 1 && wordCount < 250)) {
    return {
      classification: "auth_wall",
      usable: false,
      recommendedUpgrade: "user_action",
      reason: "Login wall or subscription gate detected; cannot treat boilerplate as primary evidence.",
    };
  }

  if (emptyShellPatterns.some((re) => re.test(trimmed)) || (trimmed.length < 18 && !/[\p{L}\p{N}]/u.test(trimmed))) {
    return {
      classification: "shell",
      usable: false,
      recommendedUpgrade: "browser",
      reason: "Client-side JavaScript shell detected; requires rendered DOM.",
    };
  }

  // Short genuine announcements (e.g. maintenance notice, version release string) remain valid even under 200 chars.
  if (trimmed.length < 12) {
    return {
      classification: "unusable_body",
      usable: false,
      reason: "Body text is too short to form verifiable evidence.",
    };
  }

  return {
    classification: "verified",
    usable: true,
    reason: "Readable primary text passed quality triage.",
  };
}
