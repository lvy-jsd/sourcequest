import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import WebRuntime from "@deepseek-ai/dsh-web";
import * as sourcequest from "../../dist/index.js";

const execFileAsync = promisify(execFile);

test("E2E: full plugin mount registers all v0.1 + G7 tools, executes doctor/research, and cleans up on disposal", async () => {
  const ctx = new Context();
  const sys = ctx.plugin(SystemPrompt);
  const tools = ctx.plugin(ToolsService);
  const web = ctx.plugin(WebRuntime);
  try {
    await sys.await();
    await tools.await();
    await web.await();
    ctx.web.registerSearchProvider({
      id: "e2e-host",
      available: () => true,
      async search() {
        return { sources: [], truncated: false };
      },
    });
    const scopeKey = { id: "e2e-agent" };
    const scope = createScope(ctx, scopeKey);
    try {
      const plugin = scope.ctx.plugin(sourcequest);
      await plugin.await();

      const schemas = ctx.tools.schemas(scopeKey).map((s) => s.name);
      for (const expected of ["sourcequest_status", "net_research", "net_job", "sourcequest_doctor", "web_extract", "web_map", "web_crawl", "feed_fetch", "resource_acquire"]) {
        assert.equal(schemas.includes(expected), true, `Missing registered tool: ${expected}`);
      }

      const doctor = ctx.tools.executable("sourcequest_doctor", scopeKey);
      assert.ok(doctor);
      const docOut = await doctor.execute({}, { signal: new AbortController().signal });
      assert.equal(docOut.coreReady, true);

      await plugin.dispose();
      assert.equal(ctx.tools.get("sourcequest_doctor", scopeKey), undefined);
    } finally {
      await scope.dispose();
    }
  } finally {
    await web.dispose();
    await tools.dispose();
    await sys.dispose();
  }
});

test("E2E: 50-case stratified evaluation suite passes dev/holdout split with honest unsupported accounting", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["benchmark/eval-50.mjs"], {
    cwd: new URL("../..", import.meta.url),
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.summary.totalCases, 50);
  assert.equal(parsed.summary.devPassed, 30);
  assert.equal(parsed.summary.holdoutPassed, 20);
  assert.equal(parsed.summary.unsupportedTruthfullyMarked, 10);
  assert.equal(parsed.summary.allAssertionsPassed, true);
});
