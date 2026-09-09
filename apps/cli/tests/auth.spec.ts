import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthOperations } from '../src/auth.ts'
import { runAuth } from '../src/auth.ts'

afterEach(() => { vi.restoreAllMocks() })

function operations(overrides: Partial<AuthOperations> = {}): AuthOperations {
  return {
    login: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ configured: false })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('runAuth', () => {
  it('forwards Copilot device-code events and the enterprise domain', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const auth = operations({
      login: vi.fn(async (options: Parameters<AuthOperations['login']>[0]) => {
        options.notify({
          type: 'device_code',
          verificationUri: 'https://github.example/login/device',
          userCode: 'ABCD-EFGH',
        })
      }),
    })
    const code = await runAuth({
      mode: 'auth',
      action: 'login',
      provider: 'github-copilot',
      enterpriseDomain: 'github.example',
    }, auth)

    expect(code).toBe(0)
    expect(auth.login).toHaveBeenCalledWith(expect.objectContaining({ enterpriseDomain: 'github.example' }))
    expect(stdout.mock.calls.map(([text]) => text).join('')).toContain(
      'Open https://github.example/login/device and enter code ABCD-EFGH.',
    )
  })

  it('reports status and logout without exposing credential fields', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const auth = operations({
      status: vi.fn(async () => ({ configured: true, type: 'oauth' as const, expires: 123 })),
    })

    expect(await runAuth({ mode: 'auth', action: 'status', provider: 'github-copilot' }, auth)).toBe(0)
    expect(await runAuth({ mode: 'auth', action: 'logout', provider: 'github-copilot' }, auth)).toBe(0)
    expect(stdout.mock.calls.map(([text]) => text).join('')).toBe(
      'GitHub Copilot: signed in with OAuth.\nGitHub Copilot: signed out.\n',
    )
  })

  it('returns a concise failure without throwing', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const auth = operations({ status: vi.fn(async () => { throw new Error('credential file unavailable') }) })

    expect(await runAuth({ mode: 'auth', action: 'status', provider: 'github-copilot' }, auth)).toBe(1)
    expect(stderr).toHaveBeenCalledWith('dsh auth: credential file unavailable\n')
  })
})
