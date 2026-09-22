/**
 * How model-provider, MCP and OAuth traffic reaches the network. Runtime-neutral on purpose: the
 * guarded variant needs Node DNS and undici, so it installs itself when `ssrfGuard` loads (the core barrel
 * does) and a runtime that never loads it keeps the platform fetch and no URL check.
 */
export interface OutboundPolicy {
  fetch: typeof fetch;
  /** Same as `fetch`, for long-idle MCP SSE / streamable-HTTP connections. */
  mcpFetch: typeof fetch;
  /** Rejects a URL the host must never call; used when a URL is saved, before any request. */
  assertUrl: (input: string | URL | Request) => Promise<void>;
}

const platformFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

let policy: OutboundPolicy = {
  fetch: platformFetch,
  mcpFetch: platformFetch,
  assertUrl: () => Promise.resolve(),
};

export function setOutboundPolicy(next: OutboundPolicy): void {
  policy = next;
}

export function outboundFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return policy.fetch(input, init);
}

export function mcpOutboundFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return policy.mcpFetch(input, init);
}

export function assertOutboundUrl(input: string | URL | Request): Promise<void> {
  return policy.assertUrl(input);
}
