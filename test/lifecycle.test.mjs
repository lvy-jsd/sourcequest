import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import * as sourcequest from "../dist/index.js";

test("registers the diagnostic in its scope, executes it and removes it on disposal", async () => {
  const ctx = new Context();
  const systemPrompt = ctx.plugin(SystemPrompt);
  const tools = ctx.plugin(ToolsService);
  try {
    await systemPrompt.await();
    await tools.await();
    const scopeKey = {};
    const scope = createScope(ctx, scopeKey);
    try {
      const plugin = scope.ctx.plugin(sourcequest);
      await plugin.await();

      assert.equal(ctx.tools.get("sourcequest_status"), undefined);
      assert.equal(ctx.tools.get("sourcequest_status", {}), undefined);
      const diagnostic = ctx.tools.executable("sourcequest_status", scopeKey);
      assert.ok(diagnostic);
      const value = await diagnostic.execute({}, { signal: new AbortController().signal });
      assert.deepEqual(value, { plugin: "sourcequest", status: "loaded" });
      assert.deepEqual(diagnostic.output.render({}, value), [
        { type: "text", text: '{"plugin":"sourcequest","status":"loaded"}' },
      ]);

      await plugin.dispose();
      assert.equal(ctx.tools.get("sourcequest_status", scopeKey), undefined);
    } finally {
      await scope.dispose();
    }
  } finally {
    await tools.dispose();
    await systemPrompt.dispose();
  }
});
