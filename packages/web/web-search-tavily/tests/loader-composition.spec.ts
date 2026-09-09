/**
 * Real-composition guard for the Tavily provider: `dsh-web` and
 * `web-search-tavily` boot from a test-only cordis.yml through the actual
 * Loader + Include path with Tavily selected as the search provider, then
 * `ctx.web.search` runs one real network round trip against a local mock Tavily
 * endpoint (no credential leak, no external network). The composed search
 * returns the seam-normalized result, and disposing the provider entry removes
 * it from `ctx.web` so a later search fails selection — the HMR-safe removal a
 * hand-built `ctx.plugin(...)` suite cannot prove through the Loader.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Include as IncludeTree } from '@deepseek-ai/cordis-plugin-include'
import WebRuntime from '@deepseek-ai/dsh-web'
import { TAVILY_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-tavily'
import * as TavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { closeMockTavilyServers, mockTavilyServer } from './mock-tavily-server.ts'

// A syntactically valid Tavily-style token that never leaves the local mock
// endpoint: the test asserts it appears on the request the loopback server
// received, so a regression that dropped auth would fail here.
const TEST_KEY = 'tvly-loader-composition-test'

let root: string | undefined
let context: Context | undefined
let configPath: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  configPath = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockTavilyServers()
})

/** The composition body: the `web` selector row plus the Tavily provider row, or just `web` when omitted. */
function configBody(baseURL: string, withProvider: boolean): string {
  return [
    '- id: web',
    "  name: '@deepseek-ai/dsh-web'",
    '  config:',
    `    searchProvider: ${TAVILY_PROVIDER_ID}`,
    ...withProvider
      ? [
        '- id: web-search-tavily',
        "  name: '@deepseek-ai/dsh-web-search-tavily'",
        '  config:',
        `    apiKey: ${JSON.stringify(TEST_KEY)}`,
        `    baseURL: ${JSON.stringify(baseURL)}`,
        '    searchDepth: advanced',
        '    topic: news',
        '    includeAnswer: true',
      ]
      : [],
    '',
  ].join('\n')
}

/** Boot `dsh-web` + `web-search-tavily` from a real cordis.yml pointed at `baseURL`; returns the Include for later refreshes. */
async function bootComposition(baseURL: string): Promise<{ ctx: Context; include: IncludeTree }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-web-tavily-composition-'))
  configPath = join(root, 'cordis.yml')
  await writeFile(configPath, configBody(baseURL, true))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-web', WebRuntime],
    ['@deepseek-ai/dsh-web-search-tavily', TavilyPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.subtree !== undefined)
  if (entry?.subtree === undefined) throw new Error('booted tree has no include entry')
  return { ctx, include: entry.subtree as IncludeTree }
}

describe('web-search-tavily real Loader composition through cordis.yml', () => {
  it('boots cordis.yml, routes ctx.web.search to the selected Tavily provider, and normalizes the result', async () => {
    const server = await mockTavilyServer({
      answer: 'the synthesized answer',
      results: [
        { url: 'https://a.test', title: 'A', content: 'first snippet', published_date: '2026-01-01' },
        { url: 'https://b.test' },
        { url: 'https://c.test', content: 'third snippet' },
      ],
    })
    const ctx = (await bootComposition(server.url)).ctx

    // The composed seam owns selection: no ambiguity, Tavily was pinned by config.
    const result = await ctx.web.search({ query: 'launch news', maxResults: 8 })
    expect(result).toEqual({
      content: 'the synthesized answer',
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'first snippet', publishedAt: '2026-01-01' },
        { url: 'https://c.test', snippet: 'third snippet' },
      ],
      truncated: false,
    })

    // The real network round trip carried the configured key and request body to
    // the loopback endpoint only — the credential never left the local server.
    expect(server.requests).toHaveLength(1)
    const [request] = server.requests
    expect(request?.path).toBe('/search')
    expect(request?.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(request?.body).toEqual({
      query: 'launch news',
      search_depth: 'advanced',
      topic: 'news',
      include_answer: true,
      max_results: 8,
    })
  })

  it('removes the provider from ctx.web when its Loader entry leaves the composition', async () => {
    const server = await mockTavilyServer({ results: [] })
    const { ctx, include } = await bootComposition(server.url)
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })

    // Re-read the config without the provider row and refresh through the real
    // Include: dropping the entry unwinds the provider's registration effect,
    // so the seam then reports the still-configured id as missing.
    await writeFile(configPath!, configBody(server.url, false))
    await include.refresh()
    await ctx.loader.await()

    expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'web-search-tavily')).toBe(false)
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })
})
