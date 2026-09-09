# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

A [Tavily](https://tavily.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Tavily's `POST /search` endpoint and maps the flat `results[]` plus the optional synthesized `answer` into the seam's normalized `WebSearchResult`. Tavily is a retrieval service built for LLM agents: it returns extracted page snippets ready to cite, and can optionally synthesize a short answer.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service. It is not part of the shipped default provider set; a deployment opts in by adding it to its `cordis.yml`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$TAVILY_API_KEY` | Tavily API key. Empty/absent makes the provider unavailable. Prefer the launch environment or a gitignored root `.env` over a literal value. |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily's `search_depth`: `basic` (fast, lower cost) or `advanced` (deeper crawl). |
| `topic` | `general` | Search category sent as Tavily's `topic`: `general`, `news`, or `finance`. |
| `includeAnswer` | `false` | When true, requests Tavily's synthesized answer (`include_answer`), mapped to the result's `content`. |

```yaml
# Export TAVILY_API_KEY in the launch environment or a gitignored root .env;
# the provider reads it automatically, so the secret stays out of cordis.yml.
# The conservative defaults (basic / general / includeAnswer false) suit
# general coding search, so no config block is needed to start.
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
```

Providing `apiKey` as a literal is supported but discouraged: keep the secret in the launch environment or a gitignored root `.env` (as `TAVILY_API_KEY`) so it is never committed. The key is sent only to the configured endpoint as a `Bearer` credential and is never logged.

## Selecting Tavily in the Web profile

The shipped Web profile mounts DeepSeek search and pins it with `web.searchProvider: deepseek-official`. To switch a Web deployment to Tavily from this checkout:

1. Install the local package into the `web` profile (from the repository root):

   ```sh
   pnpm dsh plugin --profile web add ./packages/web/web-search-tavily
   ```

   This runs `pnpm add` in `$DSH_HOME/profiles/web/`, so the bare row name `@deepseek-ai/dsh-web-search-tavily` resolves at boot. (A published deployment adds the package name instead of the path.)

2. Put the key in a gitignored root `.env` at the repository root (never commit it):

   ```sh
   TAVILY_API_KEY=your-tavily-key
   ```

3. Edit `$DSH_HOME/profiles/web/cordis.patch.yml` to both **re-point the selection** and **insert the provider row**. A patch replaces the targeted row's whole `config`, so the `web` row must restate `searchProvider` in full — merging is not performed:

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

Leaving DeepSeek mounted alongside Tavily is fine: the explicit `searchProvider: tavily` selects Tavily and avoids the seam's `WEB_PROVIDER_AMBIGUOUS` error. Verify the composed tree with `dsh --profile web --dump-config`.

## Mapping

`content` ← `answer` (present only when `includeAnswer` requested a non-blank answer; omitted otherwise). Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `content` (the extracted page snippet — a result with no non-blank `content` has no portable snippet and is dropped), `publishedAt` ← `published_date`. A request's `maxResults` is sent as Tavily's `max_results` for a cost/latency optimization; the final bound is enforced by the seam. Blank optional fields are omitted rather than emitted empty. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`, preferring Tavily's nested `detail.error` message; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, extracted snippets, and publication dates, the synthesized answer as leading `content` when `includeAnswer` is set, or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, and `Tavily returned an unprocessable response body: <error>` failures under the consumer's error wrapper. Provider-private fields (relevance score, raw content) remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A result with no non-blank `content` is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `searchDepth`/`topic`/`includeAnswer` are exposed** — Tavily's other controls (domain include/exclude, time range, `days`, raw content, images) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **The synthesized answer costs extra provider latency** — `includeAnswer` asks Tavily to generate an answer per search; leave it off when only citations are needed.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
