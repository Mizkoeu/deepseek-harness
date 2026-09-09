/**
 * Local Tavily stand-in for the real-composition test: a `node:http` server that
 * records each request's body and headers and replies with one scripted JSON
 * response. It lets the composition exercise `ctx.web.search` against a real
 * network round trip without contacting Tavily or leaking a real key.
 * @module @deepseek-ai/dsh-web-search-tavily/tests/mock-tavily-server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One recorded request the mock Tavily endpoint received. */
export interface RecordedRequest {
  /** Parsed JSON request body. */
  readonly body: unknown
  /** Request header bag. */
  readonly headers: IncomingMessage['headers']
  /** Request path (`/search`). */
  readonly path: string | undefined
}

/** A running mock Tavily server plus its recorded traffic. */
export interface MockTavilyServer {
  /** Base URL to configure as the provider `baseURL` (no trailing slash). */
  readonly url: string
  /** Requests received, in arrival order. */
  readonly requests: RecordedRequest[]
  /** Shut the server down. */
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockTavilyServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/**
 * Start a mock Tavily endpoint that replies to every request with `responseBody`.
 * @param responseBody - the JSON payload returned for each `POST /search`.
 * @returns the running server and its recorded request log.
 */
export async function mockTavilyServer(responseBody: unknown): Promise<MockTavilyServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({ body: body.length > 0 ? JSON.parse(body) : undefined, headers: request.headers, path: request.url })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseBody))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock Tavily server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
