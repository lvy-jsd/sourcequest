import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "sourcequest";
export const inject = ["tools"];

const status = defineTool({
  name: "sourcequest_status",
  description: "Check whether the SourceQuest plugin is loaded.",
  parameters: {},
  isConcurrencySafe: () => true,
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        plugin: { type: "string", const: "sourcequest", required: true },
        status: { type: "string", const: "loaded", required: true },
      },
    },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  },
  async execute(_args, { signal }) {
    signal.throwIfAborted();
    return { plugin: "sourcequest", status: "loaded" } as const;
  },
});

export function apply(ctx: Context): void {
  // register() owns the tool for the lifetime of this Cordis context.
  ctx.tools.register(status);
}
