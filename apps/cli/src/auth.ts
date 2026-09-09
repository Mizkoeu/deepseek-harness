/**
 * Terminal presentation for provider-native authentication. Provider packages
 * own credential persistence and protocol flows; this launcher owns argv,
 * progress output, and process status.
 * @module @deepseek-ai/dsh/auth
 */

import {
  githubCopilotAuthStatus,
  loginGitHubCopilot,
  logoutGitHubCopilot,
  PI_AI_CREDENTIALS_FILENAME,
} from '@deepseek-ai/dsh-llm-pi-ai/auth'
import type { PiAiAuthEvent } from '@deepseek-ai/dsh-llm-pi-ai/auth'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AuthInvocation } from './args.ts'

/** Injectable operations used by focused command tests. */
export interface AuthOperations {
  /** Start GitHub Copilot device login. */
  login: typeof loginGitHubCopilot
  /** Read non-secret GitHub Copilot login status. */
  status: typeof githubCopilotAuthStatus
  /** Remove the GitHub Copilot login. */
  logout: typeof logoutGitHubCopilot
}

const defaultOperations: AuthOperations = {
  login: loginGitHubCopilot,
  status: githubCopilotAuthStatus,
  logout: logoutGitHubCopilot,
}

/** Prove exhaustive handling when pi-ai extends its auth event union. */
function assertNever(value: never): never {
  throw new Error(`dsh auth: unsupported authentication event ${JSON.stringify(value)}`)
}

/** Present one provider event without logging any credential. */
function printAuthEvent(event: PiAiAuthEvent): void {
  switch (event.type) {
    case 'device_code':
      process.stdout.write(`Open ${event.verificationUri} and enter code ${event.userCode}.\n`)
      return
    case 'progress':
    case 'info':
      process.stdout.write(`${event.message}\n`)
      if (event.type === 'info') {
        for (const link of event.links ?? []) {
          process.stdout.write(`${link.label === undefined ? '' : `${link.label}: `}${link.url}\n`)
        }
      }
      return
    case 'auth_url':
      process.stdout.write(`Open ${event.url}.\n`)
      if (event.instructions !== undefined) process.stdout.write(`${event.instructions}\n`)
      return
    default:
      return assertNever(event)
  }
}

/**
 * Run one parsed provider-auth command.
 * @param invocation - validated auth action from the launcher parser.
 * @param operations - provider operations; injectable for tests.
 * @returns the process exit code without exiting the caller.
 */
export async function runAuth(
  invocation: AuthInvocation,
  operations: AuthOperations = defaultOperations,
): Promise<number> {
  try {
    switch (invocation.action) {
      case 'login':
        await operations.login({
          ...invocation.enterpriseDomain === undefined
            ? {}
            : { enterpriseDomain: invocation.enterpriseDomain },
          notify: printAuthEvent,
        })
        process.stdout.write(
          `GitHub Copilot: signed in; credential stored at ${dshHomeDisplay(resolveDshHome())}/${PI_AI_CREDENTIALS_FILENAME}.\n`,
        )
        return 0
      case 'status': {
        const status = await operations.status()
        process.stdout.write(status.configured
          ? `GitHub Copilot: signed in with ${status.type === 'oauth' ? 'OAuth' : 'an API key'}.\n`
          : 'GitHub Copilot: not signed in.\n')
        return 0
      }
      case 'logout':
        await operations.logout()
        process.stdout.write('GitHub Copilot: signed out.\n')
        return 0
      default:
        return assertNever(invocation.action)
    }
  } catch (error) {
    process.stderr.write(`dsh auth: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
