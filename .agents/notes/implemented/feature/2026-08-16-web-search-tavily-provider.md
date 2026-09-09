# Agent Note: Tavily-backed web search provider

Status: implemented

English | [中文](2026-08-16-web-search-tavily-provider.zh.md)

## Problem

The web capability seam (`ctx.web`) already carries Exa, Perplexity, and native DeepSeek search providers, but no first-class integration for [Tavily](https://tavily.com), a retrieval API purpose-built for LLM agents. Tavily differs from the existing providers in a way that matters to the seam: it is a dedicated retrieval service that returns pre-extracted, citation-ready page snippets, and it can *optionally* synthesize a short answer on the same request. Exa returns highlights but no answer; Perplexity is fundamentally an answer generator whose citations are a side effect and whose result count cannot be bounded on the wire. A deployment that wants agent-tuned retrieval with an on-demand answer had no supported backend.

## Decision

`@deepseek-ai/dsh-web-search-tavily` registers a `TavilySearchProvider` (id `tavily`) into `ctx.web`, modeled structurally on `web-search-exa`: a function/namespace plugin (`inject: ['web']`) with no default export, whose `apply` resolves env-var and constant defaults into fully-resolved provider options before construction. It is not in the shipped default provider set; a deployment opts in through its `cordis.yml`.

The provider calls Tavily's current `POST https://api.tavily.com/search` with `Authorization: Bearer <key>` — the authentication format confirmed against the live endpoint, which returns `{"detail":{"error":"Unauthorized: missing or invalid API key."}}` for a bad key rather than guessing at a request-body `api_key` field. Config exposes only evidence-backed Tavily controls that map cleanly to the seam: `apiKey` (falling back to `$TAVILY_API_KEY`), `baseURL` (default `https://api.tavily.com`), `searchDepth` (`basic`|`advanced`, default `basic`), `topic` (`general`|`news`|`finance`, default `general`), and `includeAnswer` (default `false`). A request's `maxResults` is sent as Tavily's `max_results`; the seam still enforces the final bound.

Tavily is a *dedicated retrieval* service, so its answer is opt-in: `includeAnswer` defaults off, and only when set does the provider map Tavily's synthesized `answer` to the seam's optional `content`. This is the deliberate inverse of Perplexity, whose answer is the primary product and always present. Each result maps `url/title/content/published_date` to a normalized source, using `content` (the extracted snippet) as `snippet`; a result with no non-blank `content` is dropped because the seam has no other field to derive a portable snippet from, and inventing one would lie. Blank optional fields are omitted rather than emitted empty.

The credentialed request uses `redirect: 'error'`, matching the web-package rule that no credential-bearing provider request follows a redirect: the `Bearer` key is sent only to the configured endpoint and is never forwarded to a `Location` origin. The key is never logged. Provider, network, malformed-body, and HTTP failures normalize to `WebError` `WEB_PROVIDER_ERROR` (preferring Tavily's nested `detail.error` message), and abort surfaces as `WEB_ABORTED`, consistent with the sibling providers. `available()` is local-only: it validates a non-empty key and a parseable base URL, making no network call.

## Alternatives considered

**Send the key as a request-body `api_key` field.** Rejected: the live endpoint accepts and documents `Authorization: Bearer`, and putting the secret in the JSON body would place it in a logged request payload and diverge from every sibling provider's header-based auth. The task required following actual authentication evidence, not guessing.

**Always request the synthesized answer.** Rejected: Tavily's identity is retrieval, the answer costs extra provider latency, and a search that only needs citations should not pay for generation. `includeAnswer` defaults off; Perplexity's always-on answer is appropriate there because generation *is* the Perplexity product.

**Expose Tavily's full control surface (domain include/exclude, time range, `days`, raw content, images) now.** Rejected: those controls have no provider-neutral home on the current `WebSearchRequest`/config seam, and inventing per-provider config that the tool layer cannot drive would violate the seam's provider-neutral design. They wait on Service Definition fields, recorded as a Known Limitation, exactly as Exa and Perplexity defer their extra controls.

**Reuse `content` as the always-present snippet source without a drop rule.** Rejected: a Tavily result can arrive with empty `content`; emitting an empty snippet or a fabricated one would make the seam lie. Dropping snippet-less entries mirrors Exa's highlight-drop rule.

## Consequences

A deployment can register `web-search-tavily` for agent-tuned retrieval, optionally getting a synthesized answer as leading `content`, with the same error/cancellation/redirect posture as the other providers. The package is registered in `tsconfig.host.json` and `python/sdk-runtime/package.json` alongside Exa and Perplexity, and listed in the `packages/web` README map (English and Chinese). No shipped default provider or base/web bundle changed. Tavily's advanced controls remain unavailable until the seam grows provider-neutral fields.

Verification: focused unit tests (`tests/tavily.spec.ts`) cover result/response mapping (answer→`content`, snippet drop, blank-field omission), availability, request-body construction, `max_results` pass-through, abort propagation, the `detail`/`detail.error`/status-line error paths, the `redirect: 'error'` opt-in with a redirect-rejection regression proving no second request, in-context registration/disposal, and the `unwrapExports` namespace-shape path that a default export would collapse. The REAL-composition guard `tests/loader-composition.spec.ts` boots `dsh-web` + `web-search-tavily` from a test-only `cordis.yml` through the actual Loader + Include path with Tavily pinned as `searchProvider`, runs `ctx.web.search` over a real network round trip against a local `node:http` mock Tavily endpoint (`tests/mock-tavily-server.ts`) — asserting the seam-normalized result and that the configured `Bearer` key and request body reached the loopback endpoint only, never leaking a real credential — and then drops the provider row through `include.refresh()` to prove the registration effect unwinds so a later search fails selection with `WEB_PROVIDER_CONFIGURED_MISSING`. A real-API e2e self-skips without `$TAVILY_API_KEY` and spends exactly one paid search: it sets `includeAnswer: true` so the single request asserts both the mapped sources and the synthesized `content`. `tsc -b` on the package typechecks clean.
