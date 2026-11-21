import { AsyncLocalStorage } from "node:async_hooks";
import type { WebFetchProvider, WebRuntime, WebSearchProvider } from "@deepseek-ai/dsh-web";
import type { SearchProvider } from "../core/search-router.js";
import type { ReadPage } from "../core/research.js";

const internalReentrancyGuard = new AsyncLocalStorage<boolean>();

export type ExplicitWebBridgeOptions = {
  providerId?: string;
  title?: string;
  searchProvider: SearchProvider;
  readPage: (url: string, signal: AbortSignal) => Promise<ReadPage>;
  enabled?: boolean;
};

export class ExplicitDshWebBridge {
  private readonly disposers: (() => void)[] = [];
  private active = false;

  constructor(private readonly web: WebRuntime, private readonly options: ExplicitWebBridgeOptions) {}

  static isInsideInternalCall(): boolean {
    return internalReentrancyGuard.getStore() === true;
  }

  static runGuarded<T>(fn: () => Promise<T>): Promise<T> {
    return internalReentrancyGuard.run(true, fn);
  }

  register(): boolean {
    if (this.active || !this.options.enabled) return false;
    const providerId = this.options.providerId ?? "sourcequest-explicit";

    const searchProvider: WebSearchProvider = {
      id: providerId,
      title: this.options.title ?? "SourceQuest Explicit Provider",
      available: () => !ExplicitDshWebBridge.isInsideInternalCall(),
      search: async (request, signal) => {
        if (ExplicitDshWebBridge.isInsideInternalCall()) {
          throw new Error("Re-entrant SourceQuest provider invocation prevented.");
        }
        const ac = signal ? AbortSignal.any([signal]) : new AbortController().signal;
        const hits = await ExplicitDshWebBridge.runGuarded(() =>
          this.options.searchProvider.search(request.query, request.maxResults ?? 3, ac),
        );
        const max = request.maxResults ?? hits.length;
        return {
          sources: hits.slice(0, max).map((h) => ({
            url: h.url,
            title: h.title,
            snippet: h.snippet,
          })),
          truncated: hits.length > max,
        };
      },
    };

    const fetchProvider: WebFetchProvider = {
      id: providerId,
      title: this.options.title ?? "SourceQuest Explicit Fetcher",
      available: () => !ExplicitDshWebBridge.isInsideInternalCall(),
      fetch: async (request, signal) => {
        if (ExplicitDshWebBridge.isInsideInternalCall()) {
          throw new Error("Re-entrant SourceQuest fetch invocation prevented.");
        }
        const ac = signal ? AbortSignal.any([signal]) : new AbortController().signal;
        const page = await ExplicitDshWebBridge.runGuarded(() => this.options.readPage(request.url, ac));
        return {
          url: page.finalUrl,
          statusCode: 200,
          body: page.mime.toLowerCase().includes("html")
            ? { kind: "html", content: page.text }
            : { kind: "text", content: page.text },
          truncated: false,
        };
      },
    };

    this.disposers.push(this.web.registerSearchProvider(searchProvider));
    this.disposers.push(this.web.registerFetchProvider(fetchProvider));
    this.active = true;
    return true;
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      try {
        fn?.();
      } catch {
        // Ignore already disposed handles on shutdown.
      }
    }
    this.active = false;
  }

  isRegistered(): boolean {
    return this.active;
  }
}
