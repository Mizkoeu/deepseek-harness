/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API (`POST /search`).
 * Tavily is a retrieval service purpose-built for LLM agents: it returns a flat `results[]` of
 * extracted page snippets and, when asked, a synthesized `answer`. This provider maps `answer` to
 * the seam's optional `content`, maps each result's `url/title/content/published_date` to a
 * normalized source, drops entries with no snippet, and omits blank optional fields.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { TavilyError, TavilyResult, TavilySearchRequest, TavilySearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default retrieval depth: the fast, lower-cost crawl. */
export const TAVILY_DEFAULT_SEARCH_DEPTH = 'basic'

/** Default search category: no domain-specific ranking bias. */
export const TAVILY_DEFAULT_TOPIC = 'general'

/** Default for the synthesized answer: off, so a search returns sources only. */
export const TAVILY_DEFAULT_INCLUDE_ANSWER = false

/** Retrieval depth accepted by Tavily's `search_depth`. */
export type TavilySearchDepth = 'basic' | 'advanced'

/** Search category accepted by Tavily's `topic`. */
export type TavilyTopic = 'general' | 'news' | 'finance'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Tavily API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth: TavilySearchDepth
  /** Search category sent as Tavily's `topic`. */
  topic: TavilyTopic
  /** Whether to request Tavily's synthesized `answer` (mapped to `content`). */
  includeAnswer: boolean
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries no
 * extracted snippet (an entry with no `content` is dropped — the seam has no other
 * field to derive a snippet from, and inventing one would lie).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no non-blank
 *   `content`.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource | undefined {
  if (result.content == null || result.content.trim().length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet: result.content,
    ...result.published_date != null && result.published_date.length > 0 ? { publishedAt: result.published_date } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; `content` is omitted when Tavily returned no
 *   non-blank answer, and snippet-less entries are dropped ({@link mapTavilyResult}).
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // The web service owns the final `maxResults` truncation, so this provider reports
  // `truncated: false`.
  return {
    ...response.answer != null && response.answer.length > 0 ? { content: response.answer } : {},
    sources,
    truncated: false,
  }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly options: TavilySearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const body: TavilySearchRequest = {
      query: request.query,
      search_depth: this.options.searchDepth,
      topic: this.options.topic,
      include_answer: this.options.includeAnswer,
      ...request.maxResults !== undefined ? { max_results: request.maxResults } : {},
    }
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = detailOf(parsed)
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/**
 * Extract the human-readable reason from a Tavily error body. Tavily nests it under
 * `detail` (string or `{ error }`); sibling `error`/`message` are accepted fallbacks.
 *
 * @param parsed - the JSON-decoded error body.
 * @returns the reason string, or `undefined` when no field carries one.
 */
function detailOf(parsed: TavilyError): string | undefined {
  if (typeof parsed.detail === 'string') return parsed.detail
  if (parsed.detail != null && typeof parsed.detail === 'object') return parsed.detail.error
  return parsed.error ?? parsed.message
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
