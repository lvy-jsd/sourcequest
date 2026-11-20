import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isPublicAddress, publicHttpsUrl } from "../dist/adapters/public-https.js";
import { research } from "../dist/core/research.js";

const normalizeUrl = (url) => publicHttpsUrl(url).href;

test("research isolates search failures, preserves query parameters and locates exact excerpts", async () => {
  const reads = [];
  const document = "Article heading\nVisible source material.\n这里记录了测试结果。\nNotes";
  const result = await research({
    queries: ["unavailable", "测试结果"],
    urls: ["https://example.com/report?v=2#heading"],
  }, {
    normalizeUrl,
    async search(query) {
      if (query === "unavailable") throw new Error("secret upstream debug payload");
      return [
        { url: "https://example.com/report?v=2#another-heading", title: "Report" },
        { url: "https://example.com/report?v=1", title: "Old report" },
        { url: "https://127.0.0.1/admin" },
      ];
    },
    async read(url) {
      reads.push(url);
      return { finalUrl: url, mime: "text/html", title: "Fixture", text: document };
    },
  }, new AbortController().signal);

  assert.equal(result.status, "partial");
  assert.deepEqual(reads, ["https://example.com/report?v=2", "https://example.com/report?v=1"]);
  assert.equal(result.sources.length, 2);
  assert.equal(result.evidence.length, 2);
  const [evidence] = result.evidence;
  assert.match(evidence.quote, /^这里记录了测试结果。/u);
  assert.equal(document.slice(evidence.start, evidence.end), evidence.quote);
  assert.equal(evidence.snapshotHash, createHash("sha256").update(document).digest("hex"));
  assert.equal(result.issues[0].code, "SEARCH_FAILED");
  assert.equal(JSON.stringify(result).includes("secret upstream"), false);
});

test("caller cancellation reaches the in-flight search and prevents reads", async () => {
  const controller = new AbortController();
  const failure = new Error("Cancelled by caller");
  const operation = research({ queries: ["query"] }, {
    normalizeUrl,
    search(_query, _limit, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    read() { assert.fail("No read should start"); },
  }, controller.signal);
  controller.abort(failure);
  await assert.rejects(operation, { message: failure.message });
});

test("read policy rejects IP literals and special-purpose DNS results", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.1.1", "192.168.1.1", "192.88.99.1", "192.0.2.1", "198.18.0.1", "224.0.0.1",
    "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fe80::1", "2002:7f00:1::",
    "2001:db8::1", "3fff::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of ["https://[::1]/", "https://2130706433/", "https://0177.0.0.1/",
    "https://metadata.google.internal/", "https://a.home.arpa/", "https://example.com:444/",
    "https://user@example.com/", "http://example.com/"]) {
    assert.throws(() => normalizeUrl(url), /public HTTPS/u, url);
  }
});
