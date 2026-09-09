import type { Credential } from '@earendil-works/pi-ai'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FilePiAiCredentialStore,
  parsePiAiCredentialsDocument,
  resolvePiAiCredentialsPath,
} from '../src/oauth-store.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-ai-oauth-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function oauth(access: string): Credential {
  return {
    type: 'oauth',
    refresh: 'github-refresh-token',
    access,
    expires: Date.now() + 60_000,
    availableModelIds: ['gpt-4.1'],
  }
}

describe('FilePiAiCredentialStore', () => {
  it('persists, lists, refreshes, and deletes a provider credential', async () => {
    const path = join(await scratch(), 'nested', 'credentials.json')
    const store = new FilePiAiCredentialStore(path)
    expect(await store.read('github-copilot')).toBeUndefined()
    expect(await store.list()).toEqual([])
    await store.delete('github-copilot')
    expect(await store.read('github-copilot')).toBeUndefined()

    await store.modify('github-copilot', async (current) => {
      expect(current).toBeUndefined()
      return oauth('first-access-token')
    })
    expect(await store.list()).toEqual([{ providerId: 'github-copilot', type: 'oauth' }])
    expect(await store.read('github-copilot')).toMatchObject({ access: 'first-access-token' })

    await store.modify('github-copilot', async (current) => {
      if (current?.type !== 'oauth') throw new Error('expected stored OAuth credential')
      return { ...current, access: 'refreshed-access-token' }
    })
    expect(await store.read('github-copilot')).toMatchObject({ access: 'refreshed-access-token' })
    expect(await store.modify('github-copilot', async () => undefined)).toMatchObject({
      access: 'refreshed-access-token',
    })

    await store.delete('github-copilot')
    expect(await store.read('github-copilot')).toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({})
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('folds concurrent store instances into one document', async () => {
    const path = join(await scratch(), 'credentials.json')
    const first = new FilePiAiCredentialStore(path)
    const second = new FilePiAiCredentialStore(path)

    await Promise.all([
      first.modify('github-copilot', async () => oauth('copilot-token')),
      second.modify('openai-codex', async () => ({
        type: 'oauth',
        refresh: 'codex-refresh-token',
        access: 'codex-access-token',
        expires: Date.now() + 60_000,
      })),
    ])

    expect(await first.list()).toEqual([
      { providerId: 'github-copilot', type: 'oauth' },
      { providerId: 'openai-codex', type: 'oauth' },
    ])
  })

  it('rejects invalid documents without quoting their secret contents', async () => {
    const path = join(await scratch(), 'credentials.json')
    const secret = 'do-not-repeat-this-secret'
    await writeFile(path, `{ "github-copilot": "${secret}" }`, { mode: 0o600 })
    const store = new FilePiAiCredentialStore(path)
    const error = await store.read('github-copilot').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TypeError)
    expect(String(error)).not.toContain(secret)
  })

  it('propagates filesystem failures and keeps its mutation queue usable', async () => {
    const dir = await scratch()
    await expect(new FilePiAiCredentialStore(`${dir}\0invalid`).read('github-copilot')).rejects.toThrow()
    await expect(new FilePiAiCredentialStore(dir).read('github-copilot')).rejects.toThrow()

    const path = join(dir, 'credentials.json')
    const store = new FilePiAiCredentialStore(path)
    await expect(store.modify('github-copilot', async () => {
      throw new Error('refresh failed')
    })).rejects.toThrow('refresh failed')
    await store.modify('github-copilot', async () => oauth('after-failure'))
    expect(await store.read('github-copilot')).toMatchObject({ access: 'after-failure' })
  })

  it('resolves explicit, environment, and constructor-default Harness homes', async () => {
    const home = await scratch()
    expect(resolvePiAiCredentialsPath(home)).toBe(join(home, '.pi-ai-credentials.json'))
    process.env.DSH_HOME = home
    try {
      expect(resolvePiAiCredentialsPath()).toBe(join(home, '.pi-ai-credentials.json'))
      expect(new FilePiAiCredentialStore().filename).toBe(join(home, '.pi-ai-credentials.json'))
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it.skipIf(process.platform === 'win32')('refuses a document readable by other users', async () => {
    const path = join(await scratch(), 'credentials.json')
    await writeFile(path, '{}\n', { mode: 0o600 })
    await chmod(path, 0o644)
    const store = new FilePiAiCredentialStore(path)
    await expect(store.list()).rejects.toThrow(/readable beyond its owner/)
  })
})

describe('parsePiAiCredentialsDocument', () => {
  it('accepts provider-specific OAuth metadata and rejects an invalid expiry', () => {
    expect(parsePiAiCredentialsDocument(JSON.stringify({
      'github-copilot': oauth('access-token'),
    }), '/credentials.json').get('github-copilot')).toMatchObject({
      type: 'oauth',
      availableModelIds: ['gpt-4.1'],
    })
    expect(() => parsePiAiCredentialsDocument(JSON.stringify({
      'github-copilot': { ...oauth('access-token'), expires: 'later' },
    }), '/credentials.json')).toThrow(/finite expiry/)
  })

  it('accepts API-key records and rejects every invalid durable form', () => {
    expect(parsePiAiCredentialsDocument(JSON.stringify({
      openai: { type: 'api_key', key: 'key', env: { OPENAI_ORG: 'org' } },
      anthropic: { type: 'api_key' },
    }), '/credentials.json')).toHaveLength(2)

    const invalid: Array<[unknown, RegExp]> = [
      ['not an object', /must contain an object/],
      [null, /must contain an object/],
      [[], /must contain an object/],
      [{ 'github-copilot': { type: 'oauth', access: 'access', expires: 1 } }, /refresh token/],
      [{ 'github-copilot': { type: 'oauth', refresh: '', access: 'access', expires: 1 } }, /refresh token/],
      [{ 'github-copilot': { type: 'oauth', refresh: 'refresh', expires: 1 } }, /access token/],
      [{ 'github-copilot': { type: 'oauth', refresh: 'refresh', access: '', expires: 1 } }, /access token/],
      [{ 'github-copilot': { type: 'oauth', refresh: 'refresh', access: 'access', expires: 'later' } }, /finite expiry/],
      [{ 'github-copilot': { type: 'oauth', refresh: 'refresh', access: 'access', expires: Infinity } }, /finite expiry/],
      [{ openai: { type: 'api_key', key: '' } }, /invalid key/],
      [{ openai: { type: 'api_key', key: 42 } }, /invalid key/],
      [{ openai: { type: 'api_key', env: 'OPENAI_ORG' } }, /invalid environment/],
      [{ openai: { type: 'api_key', env: { OPENAI_ORG: 42 } } }, /invalid environment/],
      [{ openai: { type: 'certificate' } }, /unknown type/],
      [{ '': { type: 'api_key' } }, /empty provider id/],
    ]
    for (const [document, message] of invalid) {
      expect(() => parsePiAiCredentialsDocument(JSON.stringify(document), '/credentials.json')).toThrow(message)
    }
    expect(() => parsePiAiCredentialsDocument('{', '/credentials.json')).toThrow(/invalid JSON/)
  })
})
