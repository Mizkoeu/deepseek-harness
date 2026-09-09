/**
 * Owner-only JSON persistence for pi-ai's structured provider credentials.
 * The document is separate from the Harness string credential service because
 * OAuth refresh needs to replace the complete provider record atomically.
 * @module dsh-llm-pi-ai/oauth-store
 */

import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Basename of the pi-ai OAuth document under the Harness home. */
export const PI_AI_CREDENTIALS_FILENAME = '.pi-ai-credentials.json'

/** Permission bits that would expose the credential document beyond its owner. */
const GROUP_OTHER_BITS = 0o077

/**
 * Resolve the shared pi-ai credential document path.
 * @param dshHome - explicit Harness home; omission uses normal DSH_HOME resolution.
 * @returns the absolute credential document path.
 */
export function resolvePiAiCredentialsPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), PI_AI_CREDENTIALS_FILENAME))
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Reject an existing document whose POSIX mode exposes OAuth credentials. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  /* v8 ignore next -- Windows has no POSIX permission bits to enforce. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- the POSIX peer is covered on macOS and Linux. */
  if ((mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(
      `llm-pi-ai: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before using OAuth credentials`,
    )
  }
  /* v8 ignore stop */
}

/** Whether a parsed JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one provider credential without including secret values in errors. */
function parseCredential(providerId: string, value: unknown, filename: string): Credential {
  if (!isRecord(value)) {
    throw new TypeError(`llm-pi-ai: credential "${providerId}" in ${filename} must be an object`)
  }
  if (value.type === 'oauth') {
    if (typeof value.refresh !== 'string' || value.refresh.length === 0) {
      throw new TypeError(`llm-pi-ai: OAuth credential "${providerId}" in ${filename} needs a refresh token`)
    }
    if (typeof value.access !== 'string' || value.access.length === 0) {
      throw new TypeError(`llm-pi-ai: OAuth credential "${providerId}" in ${filename} needs an access token`)
    }
    if (typeof value.expires !== 'number' || !Number.isFinite(value.expires)) {
      throw new TypeError(`llm-pi-ai: OAuth credential "${providerId}" in ${filename} needs a finite expiry`)
    }
    return value as Credential
  }
  if (value.type === 'api_key') {
    if (value.key !== undefined && (typeof value.key !== 'string' || value.key.length === 0)) {
      throw new TypeError(`llm-pi-ai: API-key credential "${providerId}" in ${filename} has an invalid key`)
    }
    if (value.env !== undefined) {
      if (!isRecord(value.env)
        || Object.values(value.env).some(entry => typeof entry !== 'string')) {
        throw new TypeError(`llm-pi-ai: API-key credential "${providerId}" in ${filename} has invalid environment values`)
      }
    }
    return value as Credential
  }
  throw new TypeError(`llm-pi-ai: credential "${providerId}" in ${filename} has an unknown type`)
}

/**
 * Parse a complete credential document; diagnostics never quote its contents.
 *
 * @param text Serialized credential document.
 * @param filename Display name for diagnostics.
 * @returns Valid credentials indexed by provider id.
 */
export function parsePiAiCredentialsDocument(text: string, filename: string): Map<string, Credential> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SyntaxError(`llm-pi-ai: invalid JSON in credential document ${filename}`)
  }
  if (!isRecord(value)) {
    throw new TypeError(`llm-pi-ai: ${filename} must contain an object keyed by provider id`)
  }
  const credentials = new Map<string, Credential>()
  for (const [providerId, credential] of Object.entries(value)) {
    if (providerId.length === 0) {
      throw new TypeError(`llm-pi-ai: ${filename} contains an empty provider id`)
    }
    credentials.set(providerId, parseCredential(providerId, credential, filename))
  }
  return credentials
}

/** Render credentials as a stable, newline-terminated JSON document. */
function renderCredentials(credentials: ReadonlyMap<string, Credential>): string {
  return `${JSON.stringify(Object.fromEntries(
    [...credentials].sort(([left], [right]) => left.localeCompare(right)),
  ), null, 2)}\n`
}

/**
 * Persistent pi-ai credential store. Reads are lock-free over atomic file
 * replacement; writes re-read under a cross-process lock before committing.
 */
export class FilePiAiCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<void>>()

  /** @param filename - credential document path; defaults under the Harness home. */
  constructor(readonly filename: string = resolvePiAiCredentialsPath()) {}

  /** Read and validate the current complete document. */
  private async readAll(): Promise<Map<string, Credential>> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return new Map()
      throw error
    }
    return parsePiAiCredentialsDocument(text, this.filename)
  }

  /** Serialize same-process mutations per provider before taking the file lock. */
  private enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const task = previous.then(operation)
    this.chains.set(providerId, task.then(() => undefined, () => undefined))
    return task
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return structuredClone((await this.readAll()).get(providerId))
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...(await this.readAll())].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.filename, async () => {
        const credentials = await this.readAll()
        const current = structuredClone(credentials.get(providerId))
        const next = await fn(current)
        if (next === undefined) return current
        credentials.set(providerId, structuredClone(next))
        await writeFileAtomic(this.filename, renderCredentials(credentials), {
          mode: 0o600,
          dirMode: 0o700,
        })
        return structuredClone(next)
      })
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.filename, async () => {
        const credentials = await this.readAll()
        if (!credentials.delete(providerId)) return
        await writeFileAtomic(this.filename, renderCredentials(credentials), {
          mode: 0o600,
          dirMode: 0o700,
        })
      })
    })
  }
}
