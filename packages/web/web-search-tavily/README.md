---
description: "The Tavily-backed search provider for ctx.web: how deployments mount LLM-oriented web search with citeable snippets, an optional synthesized answer, and Tavily selection in the Web profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-tavily`, the harness searches the web through [Tavily](https://tavily.com), a retrieval service built for LLM agents, and gets extracted page snippets ready to cite. Choose it when a deployment has a Tavily API key. Tavily can also synthesize a short answer, at the cost of extra provider latency. A result with no non-blank snippet is dropped, so a call can return fewer sources than requested. The provider is not in the shipped default set; a deployment opts in through its `cordis.yml`. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `tavily` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: tavily`.

### When to choose it

Choose this backend when a deployment holds a Tavily API key and wants extracted page snippets ready to cite, optionally with a short synthesized answer. The provider is unavailable — and every search call fails with a structured error — when the key is empty or absent, or when the endpoint base does not parse.

### Minimal configuration

Load the provider beside the web service. The API key falls back to `$TAVILY_API_KEY` from the launch environment or a gitignored root `.env`, so the secret stays out of `cordis.yml`, and the conservative defaults suit general coding search.

```yaml
# Export TAVILY_API_KEY in the launch environment or a gitignored root .env;
# the provider reads it automatically, so the secret stays out of cordis.yml.
# The conservative defaults (basic / general / includeAnswer false) suit
# general coding search, so no config block is needed to start.
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$TAVILY_API_KEY` | Tavily API key. Empty or absent makes the provider unavailable. Prefer the launch environment or a gitignored root `.env` over a literal value |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily's `search_depth`: `basic` (fast, lower cost) or `advanced` (deeper crawl) |
| `topic` | `general` | Search category sent as Tavily's `topic`: `general`, `news`, or `finance` |
| `includeAnswer` | `false` | When true, requests Tavily's synthesized answer (`include_answer`), mapped to the result's `content` |

Providing `apiKey` as a literal is supported but discouraged: keep the secret in the launch environment or a gitignored root `.env` (as `TAVILY_API_KEY`) so it is never committed. The provider sends the key only to the configured endpoint as a `Bearer` credential and never logs it. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-tavily) is the exhaustive source for every accepted field and its JSDoc.

### Select Tavily in the Web profile

The shipped Web profile mounts DeepSeek search and pins it with `web.searchProvider: deepseek-official`. To switch a Web deployment to Tavily from this checkout:

1. Install the local package into the `web` profile (from the repository root):

   ```sh
   pnpm dsh plugin --profile web add ./packages/web/web-search-tavily
   ```

   This runs `pnpm add` in `$DSH_HOME/profiles/web/`, so the bare row name `@deepseek-ai/dsh-web-search-tavily` resolves at boot. A published deployment adds the package name instead of the path.

2. Put the key in a gitignored root `.env` at the repository root (never commit it):

   ```sh
   TAVILY_API_KEY=your-tavily-key
   ```

3. Edit `$DSH_HOME/profiles/web/cordis.patch.yml` to both **re-point the selection** and **insert the provider row**. A patch replaces the targeted row's whole `config` without merging, so the `web` row must restate `searchProvider` in full:

   ```yaml
   # Re-point provider selection. This REPLACES the web row's config, so it must
   # restate searchProvider; the base value (deepseek-official) is not merged in.
   - id: web
     config:
       searchProvider: tavily

   # Mount the Tavily provider. TAVILY_API_KEY comes from the root .env / launch
   # environment, so no secret enters this file. The conservative defaults suit
   # general coding search; advanced depth and the news topic each cost more.
   - insert:
       - id: web-search-tavily
         name: '@deepseek-ai/dsh-web-search-tavily'
         config:
           searchDepth: basic
           topic: general
           includeAnswer: false
   ```

DeepSeek search can stay mounted beside Tavily: the explicit `searchProvider: tavily` selects Tavily and avoids the service's `WEB_PROVIDER_AMBIGUOUS` error. Verify the composed tree with `dsh --profile web --dump-config`.

### What a search returns

Each Tavily result maps to a `WebSearchSource`: `url`, `title`, the extracted page snippet (`content`) as `snippet`, and `published_date` as `publishedAt`; a result with no non-blank `content` has no portable snippet and is dropped. When `includeAnswer` requested a non-blank answer, Tavily's `answer` becomes the result's `content`; otherwise `content` is omitted. A request's `maxResults` is sent to Tavily as `max_results` for a cost and latency optimization — the final bound is enforced by the service. Blank optional fields are omitted rather than emitted empty.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`, preferring Tavily's nested `detail.error` message; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Tavily's `POST /search` API. Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend into `ctx.web`, not a default-export service: `@deepseek-ai/dsh-web` owns the `ctx.web` key, and `@deepseek-ai/dsh-tool-web` registers the model-facing tool. Two deliberate rules govern the mapping:

- **Portable snippets only.** A source gains a `snippet` only from Tavily's extracted page `content`; inventing one from other fields would make the service report a snippet the provider never returned, so snippet-less results are dropped entirely.
- **Answers only on request.** The synthesized `answer` reaches `content` only when `includeAnswer` asked for it and Tavily returned a non-blank value.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `TavilySearchProvider`: request dispatch, error-message extraction, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Tavily wire types: `TavilySearchRequest`, `TavilySearchResponse`, `TavilyResult`, `TavilyError` |

### Request and mapping flow

`search()` posts the query, `search_depth`, `topic`, `include_answer`, and optional `max_results` to `{baseURL}/search` with the key as a `Bearer` credential and `redirect: 'error'`, so a redirect fails the request without contacting the target. The flat `results[]` are mapped one by one, snippet-less entries dropped, the optional `answer` becomes `content`, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-tavily) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, extracted snippets, and publication dates, the synthesized answer as leading `content` when `includeAnswer` is set, or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, and `Tavily returned an unprocessable response body: <error>` failures under the consumer's error wrapper. Provider-private fields (relevance score, raw content) remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **A result with no non-blank `content` is dropped entirely** — there is no portable snippet to map, so fewer sources than requested can return.
- **Only `searchDepth`/`topic`/`includeAnswer` are exposed** — Tavily's other controls (domain include/exclude, time range, `days`, raw content, images) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **The synthesized answer costs extra provider latency** — `includeAnswer` asks Tavily to generate an answer per search; leave it off when only citations are needed.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
