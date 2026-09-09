/**
 * Interactive provider-auth operations over the same persistent credential
 * store used by the pi-ai adapter.
 * @module dsh-llm-pi-ai/auth
 */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, CredentialStore } from '@earendil-works/pi-ai'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { FilePiAiCredentialStore } from './oauth-store.ts'

/** pi-ai provider id for GitHub Copilot subscription authentication. */
export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot'

/** Provider-owned progress event safe for terminal presentation. */
export type PiAiAuthEvent = AuthEvent

/** Inputs for one GitHub Copilot device login. */
export interface GitHubCopilotLoginOptions {
  /** GitHub Enterprise domain; omission selects github.com. */
  enterpriseDomain?: string
  /** Whole-flow cancellation signal. */
  signal?: AbortSignal
  /** Receive device-code and progress events without receiving credentials. */
  notify: (event: AuthEvent) => void
}

/** Non-secret GitHub Copilot login status. */
export interface GitHubCopilotAuthStatus {
  configured: boolean
  type?: 'api_key' | 'oauth'
  expires?: number
}

/** Build the one-provider collection used by setup operations. */
function copilotModels(credentials: CredentialStore) {
  const models = createModels({ credentials })
  models.setProvider(githubCopilotProvider())
  return models
}

/**
 * Run GitHub's device flow and persist the resulting refreshable credential.
 * The provider owns network exchange and model-policy activation; this wrapper
 * supplies the public-GitHub or enterprise-domain answer and forwards events.
 * @param options - enterprise selection, cancellation, and progress callback.
 * @param credentials - destination store; defaults to the Harness-home document.
 * @returns after pi-ai has persisted the refreshable credential.
 */
export async function loginGitHubCopilot(
  options: GitHubCopilotLoginOptions,
  credentials: CredentialStore = new FilePiAiCredentialStore(),
): Promise<void> {
  let promptCount = 0
  await copilotModels(credentials).login(GITHUB_COPILOT_PROVIDER_ID, 'oauth', {
    ...options.signal === undefined ? {} : { signal: options.signal },
    notify: options.notify,
    prompt: (prompt) => {
      promptCount += 1
      if (promptCount !== 1 || prompt.type !== 'text') {
        throw new Error(`llm-pi-ai: GitHub Copilot login requested unsupported prompt type "${prompt.type}"`)
      }
      return Promise.resolve(options.enterpriseDomain ?? '')
    },
  })
}

/**
 * Read GitHub Copilot status without refreshing or exposing either token.
 * @param credentials - credential store; defaults to the Harness-home document.
 * @returns non-secret stored-login metadata.
 */
export async function githubCopilotAuthStatus(
  credentials: CredentialStore = new FilePiAiCredentialStore(),
): Promise<GitHubCopilotAuthStatus> {
  const credential = await credentials.read(GITHUB_COPILOT_PROVIDER_ID)
  if (credential === undefined) return { configured: false }
  return {
    configured: true,
    type: credential.type,
    ...credential.type === 'oauth' ? { expires: credential.expires } : {},
  }
}

/**
 * Remove the stored GitHub Copilot credential.
 * @param credentials - credential store; defaults to the Harness-home document.
 * @returns after the provider entry has been removed.
 */
export async function logoutGitHubCopilot(
  credentials: CredentialStore = new FilePiAiCredentialStore(),
): Promise<void> {
  await copilotModels(credentials).logout(GITHUB_COPILOT_PROVIDER_ID)
}

export {
  FilePiAiCredentialStore,
  PI_AI_CREDENTIALS_FILENAME,
  parsePiAiCredentialsDocument,
  resolvePiAiCredentialsPath,
} from './oauth-store.ts'
