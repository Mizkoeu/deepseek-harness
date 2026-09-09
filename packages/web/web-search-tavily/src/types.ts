/**
 * Wire types for the Tavily search API (`POST https://api.tavily.com/search`). Types
 * only — no runtime code. Tavily returns an optional generated `answer` plus a flat
 * `results[]`; each entry carries a URL, title, extracted `content` snippet, relevance
 * `score`, and (for news/dated pages) an optional `published_date`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  /** Retrieval depth: `basic` (fast) or `advanced` (deeper crawl, higher cost). */
  search_depth: 'basic' | 'advanced'
  /** Search category tuning Tavily's ranking: `general`, `news`, or `finance`. */
  topic: 'general' | 'news' | 'finance'
  /** Ask Tavily to synthesize an answer from the results. */
  include_answer: boolean
  /** Tavily's result-count control; the seam still enforces the bound on return. */
  max_results?: number
}

/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
  url: string
  title?: string | null
  /** Extracted page snippet Tavily selected as most relevant to the query. */
  content?: string | null
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  /** Generated answer, present only when `include_answer` was requested. */
  answer?: string | null
  results?: TavilyResult[]
}

/**
 * Tavily's error response envelope (best-effort; fields vary by failure). Tavily
 * nests the human-readable reason under `detail`, which is itself either a string
 * or an object carrying `error`.
 */
export interface TavilyError {
  detail?: string | { error?: string } | null
  error?: string
  message?: string
}
