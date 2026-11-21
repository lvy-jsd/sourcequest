import type { LlmRuntime, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { LlmPort, LlmPortResult, LlmStructuredRequest, PortCallContext } from "../ports/index.js";

export type HostLlmSelection = {
  provider: string;
  model: string;
};

export type DshLlmAdapterOptions = {
  runtime?: Pick<LlmRuntime, "prepareCall">;
  resolveSelection?: () => HostLlmSelection | undefined;
  directCall?: (
    req: LlmStructuredRequest,
    ctx: PortCallContext,
  ) => Promise<Omit<LlmPortResult<unknown>, "durationMs">>;
};

export class DshLlmError extends Error {
  constructor(
    readonly code: "NOT_CONFIGURED" | "AUTH_REQUIRED" | "RATE_LIMITED" | "TIMEOUT" | "CANCELLED" | "FAILED",
    message: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "DshLlmError";
  }
}

function tryParseJson<T>(text: string): T | undefined {
  const trimmed = text.trim();
  const clean = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim()
    : trimmed;
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(clean.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

function mapFailureCode(rawCode: string | undefined): DshLlmError["code"] {
  if (!rawCode) return "FAILED";
  if (/AUTH|KEY|CREDENTIAL/u.test(rawCode)) return "AUTH_REQUIRED";
  if (/RATE_LIMIT|QUOTA|429/u.test(rawCode)) return "RATE_LIMITED";
  if (/TIMEOUT/u.test(rawCode)) return "TIMEOUT";
  if (/NO_ADAPTER|UNAVAILABLE|MISSING/u.test(rawCode)) return "NOT_CONFIGURED";
  if (/ABORT|CANCEL/u.test(rawCode)) return "CANCELLED";
  return "FAILED";
}

export class DshLlmAdapter implements LlmPort {
  readonly id = "dsh-llm";

  constructor(private readonly options: DshLlmAdapterOptions) {}

  async generate<T = unknown>(req: LlmStructuredRequest, ctx: PortCallContext): Promise<LlmPortResult<T>> {
    ctx.signal.throwIfAborted();
    const startMs = Date.now();
    const maxContextChars = req.maxContextChars ?? 16_000;
    const boundedPrompt = req.userPrompt.slice(0, maxContextChars);

    if (this.options.directCall) {
      const out = await this.options.directCall({ ...req, userPrompt: boundedPrompt }, ctx);
      return {
        ...out,
        parsed: (out.parsed as T | undefined) ?? tryParseJson<T>(out.text),
        durationMs: Math.max(0, Date.now() - startMs),
      };
    }

    const runtime = this.options.runtime;
    const selection = this.options.resolveSelection?.();
    if (!runtime || !selection) {
      throw new DshLlmError("NOT_CONFIGURED", "Host LLM runtime or active model selection is unavailable.");
    }

    const targetModel = req.modelOverride ?? selection.model;
    const prepared = await runtime.prepareCall(
      { provider: selection.provider, model: targetModel },
      ctx.signal,
    );

    const chunks = prepared.stream({
      provider: prepared.config.provider,
      model: prepared.config.model,
      reasoningEffort: prepared.config.reasoningEffort,
      system: req.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: boundedPrompt }],
        },
      ],
      maxTokens: req.maxOutputTokens,
      signal: ctx.signal,
    });

    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const chunk of chunks as AsyncIterable<StreamChunk>) {
      ctx.signal.throwIfAborted();
      if (chunk.type === "text-delta") {
        text += chunk.text;
      } else if (chunk.type === "usage") {
        inputTokens = chunk.usage.inputTokens;
        outputTokens = chunk.usage.outputTokens;
      } else if (chunk.type === "finish") {
        if (chunk.reason.kind === "aborted") {
          throw new DshLlmError("CANCELLED", "LLM stream was aborted.", prepared.config.provider);
        }
        if (chunk.reason.kind === "error") {
          const failure = chunk.reason.failure;
          throw new DshLlmError(
            mapFailureCode(failure?.code),
            failure?.message || "Host LLM request failed.",
            prepared.config.provider,
          );
        }
      }
    }

    return {
      text,
      parsed: tryParseJson<T>(text),
      resolvedModel: prepared.config.model,
      provider: prepared.config.provider,
      inputTokens,
      outputTokens,
      cost: {
        kind: "unknown",
        currency: "USD",
        source: prepared.config.provider,
        recordedAt: new Date().toISOString(),
      },
      durationMs: Math.max(0, Date.now() - startMs),
    };
  }
}
