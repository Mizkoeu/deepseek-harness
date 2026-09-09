import { describe, expect, it } from 'vitest'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_DEFAULT_TOPIC,
} from '@deepseek-ai/dsh-web-search-tavily'

/**
 * Real-API smoke for the Tavily search provider. Self-skips without `$TAVILY_API_KEY`
 * (CI has no secrets), per the with-key e2e policy in docs/testing.md.
 *
 * One paid search only: `includeAnswer: true` lets the single request assert both the
 * mapped sources and the synthesized `content`, so this smoke never spends a second credit.
 */
const apiKey = process.env.TAVILY_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('TavilySearchProvider real API', () => {
  it('returns sources and a synthesized answer from one live query', async () => {
    const provider = new TavilySearchProvider({
      apiKey: apiKey!,
      baseURL: process.env.TAVILY_BASE_URL ?? TAVILY_DEFAULT_BASE_URL,
      searchDepth: TAVILY_DEFAULT_SEARCH_DEPTH,
      topic: TAVILY_DEFAULT_TOPIC,
      includeAnswer: true,
    })
    const result = await provider.search({ query: 'What is the capital of France?', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
    expect(result.content).toBeTypeOf('string')
    expect(result.content!.length).toBeGreaterThan(0)
  }, 30_000)
})
