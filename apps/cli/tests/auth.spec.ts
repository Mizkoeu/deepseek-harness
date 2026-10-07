import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationEntry, AuthorizationPrompt, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AuthInvocation } from '../src/args.ts'
import { openAuthHost, runAuth } from '../src/auth.ts'
import type { AuthHost, AuthTerminal } from '../src/auth.ts'

const COPILOT = recordKeyFor('github-copilot')
const COPILOT_FLOW: AuthorizationEntry = {
  key: COPILOT,
  label: 'GitHub Copilot',
  methods: [{ id: 'oauth', label: 'GitHub Copilot' }],
  inFlight: false,
}
const ENTERPRISE_PROMPT: AuthorizationPrompt = {
  kind: 'text',
  message: 'GitHub Enterprise URL/domain (blank for github.com)',
  placeholder: 'company.ghe.com',
}

/** A terminal recording output, answering prompts from a queue, with a triggerable interrupt. */
function terminal(answers: string[] = []): AuthTerminal & {
  out: string[]
  err: string[]
  asked: AuthorizationPrompt[]
  interrupt(): void
} {
  const out: string[] = []
  const err: string[] = []
  const asked: AuthorizationPrompt[] = []
  const listeners = new Set<() => void>()
  return {
    out,
    err,
    asked,
    print: (line) => { out.push(line) },
    fail: (line) => { err.push(line) },
    ask: (prompt) => {
      asked.push(prompt)
      return Promise.resolve(answers.shift() ?? '')
    },
    onInterrupt: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    interrupt: () => { for (const listener of listeners) listener() },
  }
}

/** A host offering the Copilot flow over an in-memory record table. */
function host(options: {
  stored?: CredentialRecordInfo['kind']
  begin?: (request: AuthorizationRequest) => Promise<'authorized' | 'cancelled'>
} = {}): AuthHost & { records: Map<CredentialKey, CredentialRecordInfo['kind']>; disposed: boolean; requests: AuthorizationRequest[] } {
  const records = new Map<CredentialKey, CredentialRecordInfo['kind']>()
  if (options.stored !== undefined) records.set(COPILOT, options.stored)
  const requests: AuthorizationRequest[] = []
  const fake = {
    records,
    requests,
    disposed: false,
    location: '~/.dsh/.credentials.yaml',
    providers: () => ['anthropic', 'github-copilot'],
    flow: (provider: string) => provider === 'github-copilot' ? COPILOT_FLOW : undefined,
    async begin(request: AuthorizationRequest) {
      requests.push(request)
      const status = await (options.begin ?? (() => Promise.resolve('authorized' as const)))(request)
      if (status === 'authorized') records.set(request.key, 'grant')
      return { status }
    },
    describeRecord: (key: CredentialKey) => {
      const kind = records.get(key)
      return Promise.resolve(kind === undefined
        ? { configured: false, writable: true }
        : { configured: true, kind, writable: true })
    },
    deleteRecord: (key: CredentialKey) => {
      records.delete(key)
      return Promise.resolve()
    },
    dispose: () => {
      fake.disposed = true
      return Promise.resolve()
    },
  }
  return fake
}

const login = (extra: Partial<AuthInvocation> = {}): AuthInvocation =>
  ({ mode: 'auth', action: 'login', provider: 'github-copilot', ...extra })

describe('dsh auth login', () => {
  it('relays the device code and stores the credential the flow commits', async () => {
    const ui = terminal([''])
    const auth = host({
      begin: async (request) => {
        await request.interaction.prompt(ENTERPRISE_PROMPT)
        request.interaction.notify({
          message: 'Enter this code on the verification page to finish signing in.',
          url: 'https://github.com/login/device',
          code: 'ABCD-1234',
        })
        return 'authorized'
      },
    })

    expect(await runAuth(login(), () => Promise.resolve(auth), ui)).toBe(0)

    expect(auth.requests.map(request => request.key)).toEqual([COPILOT])
    expect(ui.asked).toEqual([ENTERPRISE_PROMPT])
    expect(ui.out).toEqual([
      'Enter this code on the verification page to finish signing in.',
      '  Open: https://github.com/login/device',
      '  Code: ABCD-1234',
      `GitHub Copilot: signed in; stored as ${COPILOT} in ~/.dsh/.credentials.yaml.`,
      'Add the github-copilot provider without an API key to use it.',
    ])
    expect(auth.records.get(COPILOT)).toBe('grant')
    expect(auth.disposed).toBe(true)
  })

  it('answers the enterprise-domain prompt from --enterprise-domain and asks everything else', async () => {
    const ui = terminal(['typed'])
    const answers: string[] = []
    const other: AuthorizationPrompt = { kind: 'secret', message: 'Paste the key' }
    const auth = host({
      begin: async (request) => {
        answers.push(await request.interaction.prompt(ENTERPRISE_PROMPT))
        answers.push(await request.interaction.prompt(other))
        return 'authorized'
      },
    })

    expect(await runAuth(login({ enterpriseDomain: 'ghe.example.com' }), () => Promise.resolve(auth), ui)).toBe(0)

    expect(answers).toEqual(['ghe.example.com', 'typed'])
    expect(ui.asked).toEqual([other])
  })

  it('withdraws the attempt on interrupt and reports that nothing was stored', async () => {
    const ui = terminal()
    const auth = host({
      begin: request => new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => { resolve('cancelled') })
        ui.interrupt()
      }),
    })

    expect(await runAuth(login(), () => Promise.resolve(auth), ui)).toBe(1)

    expect(ui.err).toEqual(['dsh auth: GitHub Copilot sign-in cancelled; nothing was stored'])
    expect(auth.records.size).toBe(0)
    // The interrupt listener belongs to the attempt, not the process.
    ui.interrupt()
  })

  it('reports a failing flow with its cause and still disposes the host', async () => {
    const ui = terminal()
    const auth = host({
      begin: () => Promise.reject(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND ghe.invalid') })),
    })

    expect(await runAuth(login(), () => Promise.resolve(auth), ui)).toBe(1)

    expect(ui.err).toEqual(['dsh auth: fetch failed (getaddrinfo ENOTFOUND ghe.invalid)'])
    expect(auth.disposed).toBe(true)
  })
})

describe('dsh auth status and logout', () => {
  it.each([
    [undefined, 'GitHub Copilot: not signed in.'],
    ['grant', 'GitHub Copilot: signed in.'],
    ['api-key', 'GitHub Copilot: an API key is stored.'],
  ] as const)('reports a %s record as "%s"', async (stored, line) => {
    const ui = terminal()

    const code = await runAuth(
      { mode: 'auth', action: 'status', provider: 'github-copilot' },
      () => Promise.resolve(host(stored === undefined ? {} : { stored })),
      ui,
    )

    expect(code).toBe(0)
    expect(ui.out).toEqual([line])
  })

  it('deletes a stored record, and says so when there is none', async () => {
    const ui = terminal()
    const auth = host({ stored: 'grant' })
    const logout: AuthInvocation = { mode: 'auth', action: 'logout', provider: 'github-copilot' }

    expect(await runAuth(logout, () => Promise.resolve(auth), ui)).toBe(0)
    expect(await runAuth(logout, () => Promise.resolve(auth), ui)).toBe(0)

    expect(auth.records.size).toBe(0)
    expect(ui.out).toEqual(['GitHub Copilot: signed out.', 'GitHub Copilot: not signed in; nothing to delete.'])
  })

  it('names the providers that offer a sign-in when the requested one does not', async () => {
    const ui = terminal()
    const auth = host()

    expect(await runAuth({ mode: 'auth', action: 'status', provider: 'nope' }, () => Promise.resolve(auth), ui)).toBe(1)

    expect(ui.err).toEqual(['dsh auth: "nope" offers no sign-in; providers that do: anthropic, github-copilot'])
    expect(auth.disposed).toBe(true)
  })

  it('reports a host that cannot open', async () => {
    const ui = terminal()

    const code = await runAuth(
      { mode: 'auth', action: 'status', provider: 'github-copilot' },
      () => Promise.reject(new Error('credentials document is readable beyond its owner')),
      ui,
    )

    expect(code).toBe(1)
    expect(ui.err).toEqual(['dsh auth: credentials document is readable beyond its owner'])
  })
})

describe('openAuthHost', () => {
  const homes: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('offers the pi-ai sign-in flows over the Harness credential store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-auth-host-'))
    homes.push(home)
    vi.stubEnv('DSH_HOME', home)
    const opened = await openAuthHost(createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]), () => {})
    try {
      expect(opened.providers()).toContain('github-copilot')
      expect(opened.flow('github-copilot')).toMatchObject({ key: COPILOT, label: 'GitHub Copilot' })
      expect(opened.flow('github-copilot')?.methods[0]?.id).toBe('oauth')
      expect(opened.flow('Not A Provider')).toBeUndefined()
      await expect(opened.describeRecord(COPILOT)).resolves.toMatchObject({ configured: false })
    } finally {
      await opened.dispose()
    }
  })
})
