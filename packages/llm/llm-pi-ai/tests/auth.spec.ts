import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  githubCopilotAuthStatus,
  loginGitHubCopilot,
  logoutGitHubCopilot,
} from '../src/auth.ts'

afterEach(() => { vi.unstubAllGlobals() })

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('GitHub Copilot auth', () => {
  it('runs the device exchange through pi-ai and persists the refreshable credential', async () => {
    const store = new InMemoryCredentialStore()
    const events: string[] = []
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input)
      if (url.endsWith('/login/device/code')) {
        return Response.json({
          device_code: 'device-secret',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://ghe.example/login/device',
          interval: 1,
          expires_in: 30,
        })
      }
      if (url.endsWith('/login/oauth/access_token')) {
        return Response.json({ access_token: 'github-refresh-token' })
      }
      if (url.endsWith('/copilot_internal/v2/token')) {
        return Response.json({ token: 'copilot-access-token', expires_at: expiresAt })
      }
      if (url.endsWith('/models')) {
        return Response.json({
          data: [{
            id: 'gpt-4.1',
            model_picker_enabled: true,
            policy: { state: 'enabled' },
            capabilities: { supports: { tool_calls: true } },
          }],
        })
      }
      if (url.includes('/models/') && url.endsWith('/policy')) return new Response(null, { status: 200 })
      throw new Error(`unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetch)

    await loginGitHubCopilot({
      enterpriseDomain: 'ghe.example',
      signal: new AbortController().signal,
      notify: (event) => { events.push(event.type) },
    }, store)

    expect(events).toContain('device_code')
    expect(events).toContain('progress')
    expect(await store.read('github-copilot')).toMatchObject({
      type: 'oauth',
      refresh: 'github-refresh-token',
      access: 'copilot-access-token',
      enterpriseUrl: 'ghe.example',
      availableModelIds: ['gpt-4.1'],
    })
    expect(await githubCopilotAuthStatus(store)).toMatchObject({ configured: true, type: 'oauth' })
    expect(fetch.mock.calls.some(([input]) => requestUrl(input).startsWith('https://ghe.example/'))).toBe(true)
    expect(fetch.mock.calls.some(([input]) => requestUrl(input).startsWith('https://api.ghe.example/'))).toBe(true)

    await loginGitHubCopilot({ notify: () => undefined }, store)
    expect(fetch.mock.calls.some(([input]) => requestUrl(input).startsWith('https://github.com/'))).toBe(true)

    await store.modify('github-copilot', async () => ({ type: 'api_key', key: 'static-key' }))
    expect(await githubCopilotAuthStatus(store)).toEqual({ configured: true, type: 'api_key' })

    await logoutGitHubCopilot(store)
    expect(await githubCopilotAuthStatus(store)).toEqual({ configured: false })
  }, 5_000)
})
