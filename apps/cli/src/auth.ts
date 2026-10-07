/**
 * `dsh auth login|status|logout <provider>`: sign in to a pi-ai model provider
 * from a terminal, without booting a profile.
 *
 * The command mounts only the plugins a sign-in needs — the LLM registry the
 * pi-ai adapter injects, the local credential store, the authorization seam,
 * and the pi-ai adapter that registers one flow per provider shipping a login —
 * and drives the same `ctx.authorization` flow any other surface would. The
 * flow's notices and prompts are relayed to the terminal; the credential lands
 * in `$DSH_HOME/.credentials.yaml` as the `llm-pi-ai/<provider>` grant record
 * the adapter reads on every request. Nothing here prints a stored value.
 * @module @deepseek-ai/dsh/auth
 */

import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationEntry, AuthorizationInteraction, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationRequest,
} from '@deepseek-ai/dsh-authorization'
import { credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider, { CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-local'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { AuthInvocation } from './args.ts'

/** The services one `dsh auth` command uses. */
export interface AuthHost {
  /** Where credentials are stored, for display; never the stored values. */
  readonly location: string
  /**
   * Every pi-ai provider id that offers a sign-in.
   * @returns the ids, in the order the flows were registered.
   */
  providers(): readonly string[]
  /**
   * The sign-in flow for one provider id.
   * @param provider - pi-ai provider id as typed by the user.
   * @returns the flow, or undefined when the provider offers none.
   */
  flow(provider: string): AuthorizationEntry | undefined
  /**
   * Run one sign-in attempt through the authorization seam.
   * @param request - the flow key, the terminal interaction, and the interrupt signal.
   * @returns how the attempt ended.
   */
  begin(request: AuthorizationRequest): Promise<AuthorizationOutcome>
  /**
   * Describe one stored credential record without its value.
   * @param key - the record a flow writes.
   * @returns presence and record kind.
   */
  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>
  /**
   * Delete one stored credential record.
   * @param key - the record a flow writes.
   */
  deleteRecord(key: CredentialKey): Promise<void>
  /** Unmount every plugin and restore the process-wide HTTP agent. */
  dispose(): Promise<void>
}

/** The terminal one `dsh auth` command talks through. */
export interface AuthTerminal {
  /**
   * Write one line of command output.
   * @param line - text without a trailing newline.
   */
  print(line: string): void
  /**
   * Write one line of diagnostics.
   * @param line - text without a trailing newline.
   */
  fail(line: string): void
  /**
   * Ask the human one question a sign-in flow cannot answer itself.
   * @param prompt - the question; a `secret` answer is not echoed.
   * @returns the typed text, or the chosen option's id.
   * @throws {AuthorizationDeclinedError} when the human interrupts the prompt or no terminal can answer it.
   */
  ask(prompt: AuthorizationPrompt): Promise<string>
  /**
   * Observe the human's interrupt (Ctrl+C) outside a prompt.
   * @param listener - called on each interrupt.
   * @returns a disposer that stops observing.
   */
  onInterrupt(listener: () => void): () => void
}

/**
 * Mount the sign-in plugins over the launch environment. The proxy policy is
 * installed first, exactly as a profile boot does, so a sign-in behind an HTTP
 * proxy reaches the provider.
 * @param environment - this run's launch environment snapshot.
 * @param report - receives proxy configuration diagnostics.
 * @returns the mounted host; the caller disposes it.
 */
export async function openAuthHost(
  environment: LaunchEnvironmentSnapshot,
  report: (message: string) => void,
): Promise<AuthHost> {
  const disposeProxy = await installProxyFromEnvironment(environment, report)
  const ctx = new Context()
  const dispose = async (): Promise<void> => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await disposeProxy()
    }
  }
  try {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    await ctx.plugin(LlmRuntime)
    // A one-shot command reads and writes the document once; watching it for
    // external edits would only keep the process alive.
    await ctx.plugin(LocalCredentialProvider, { watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmPiAi, {})
  } catch (error) {
    await dispose()
    throw error
  }
  const piAiFlows = (): AuthorizationEntry[] =>
    ctx.authorization.list().filter(entry => credentialKeyScope(entry.key) === LlmPiAi.RECORD_SCOPE)
  return {
    location: join(dshHomeDisplay(resolveDshHome()), CREDENTIALS_FILENAME),
    providers: () => piAiFlows().map(entry => credentialKeyId(entry.key)),
    flow: provider => piAiFlows().find(entry => credentialKeyId(entry.key) === provider),
    begin: request => ctx.authorization.begin(request),
    describeRecord: key => ctx.credentials.describeRecord(key),
    deleteRecord: key => ctx.credentials.deleteRecord(key),
    dispose,
  }
}

/** Matches the question pi-ai's GitHub Copilot login asks before its device flow. */
const ENTERPRISE_PROMPT = /enterprise/iu

/**
 * Relay a flow's notices to the terminal and answer its prompts, taking the
 * enterprise-domain answer from the command line when one was given.
 * @param terminal - where notices go and unanswered prompts are asked.
 * @param enterpriseDomain - the `--enterprise-domain` value, when given.
 * @returns the interaction to hand the authorization seam.
 */
function terminalInteraction(terminal: AuthTerminal, enterpriseDomain: string | undefined): AuthorizationInteraction {
  return {
    notify(notice: AuthorizationNotice) {
      terminal.print(notice.message)
      if (notice.url !== undefined) terminal.print(`  Open: ${notice.url}`)
      if (notice.code !== undefined) terminal.print(`  Code: ${notice.code}`)
    },
    prompt(prompt) {
      if (enterpriseDomain !== undefined && prompt.kind === 'text' && ENTERPRISE_PROMPT.test(prompt.message)) {
        return Promise.resolve(enterpriseDomain)
      }
      return terminal.ask(prompt)
    },
  }
}

/**
 * Describe one stored record's state in user terms.
 * @param info - the record description.
 * @returns the status phrase.
 */
function statusPhrase(info: CredentialRecordInfo): string {
  if (!info.configured) return 'not signed in'
  switch (info.kind) {
    case 'grant':
      return 'signed in'
    case 'api-key':
      return 'an API key is stored'
    default:
      // The record union is open to new kinds; one this build does not know
      // is still a stored credential.
      return 'a credential is stored'
  }
}

/**
 * Run one command against an open host.
 * @param invocation - the parsed `dsh auth` command.
 * @param host - the mounted sign-in services.
 * @param terminal - where output goes and prompts are asked.
 * @returns the process exit code.
 */
async function runAgainst(invocation: AuthInvocation, host: AuthHost, terminal: AuthTerminal): Promise<number> {
  const entry = host.flow(invocation.provider)
  if (entry === undefined) {
    terminal.fail(`dsh auth: "${invocation.provider}" offers no sign-in; providers that do: ${host.providers().join(', ')}`)
    return 1
  }
  switch (invocation.action) {
    case 'login': {
      const interrupt = new AbortController()
      const stop = terminal.onInterrupt(() => { interrupt.abort() })
      let outcome: AuthorizationOutcome
      try {
        outcome = await host.begin({
          key: entry.key,
          interaction: terminalInteraction(terminal, invocation.enterpriseDomain),
          signal: interrupt.signal,
        })
      } finally {
        stop()
      }
      if (outcome.status === 'cancelled') {
        terminal.fail(`dsh auth: ${entry.label} sign-in cancelled; nothing was stored`)
        return 1
      }
      terminal.print(`${entry.label}: signed in; stored as ${entry.key} in ${host.location}.`)
      terminal.print(`Add the ${invocation.provider} provider without an API key to use it.`)
      return 0
    }
    case 'status':
      terminal.print(`${entry.label}: ${statusPhrase(await host.describeRecord(entry.key))}.`)
      return 0
    case 'logout': {
      if (!(await host.describeRecord(entry.key)).configured) {
        terminal.print(`${entry.label}: not signed in; nothing to delete.`)
        return 0
      }
      await host.deleteRecord(entry.key)
      terminal.print(`${entry.label}: signed out.`)
      return 0
    }
    default:
      invocation.action satisfies never
      throw new Error(`dsh auth: unhandled action ${JSON.stringify(invocation.action)}`)
  }
}

/**
 * One line naming a failure and its direct cause. A network failure inside a
 * provider login surfaces as Fetch's bare "fetch failed"; the cause is what
 * names the host or the refused connection.
 * @param error - what the command threw.
 * @returns the message, followed by the cause's message when it has one.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
}

/**
 * Run one `dsh auth` command. Failures are reported on the terminal rather
 * than thrown, and the host is always disposed.
 * @param invocation - the parsed command.
 * @param open - mounts the sign-in services.
 * @param terminal - where output goes and prompts are asked.
 * @returns the process exit code.
 */
export async function runAuth(
  invocation: AuthInvocation,
  open: () => Promise<AuthHost>,
  terminal: AuthTerminal = processTerminal(),
): Promise<number> {
  let host: AuthHost | undefined
  try {
    host = await open()
    return await runAgainst(invocation, host, terminal)
  } catch (error) {
    terminal.fail(`dsh auth: ${describeFailure(error)}`)
    return 1
  } finally {
    await host?.dispose()
  }
}

/** The question line for one prompt, numbering a selection's options. */
function questionText(prompt: AuthorizationPrompt): string {
  if (prompt.kind === 'select') {
    const options = prompt.options.map((option, index) =>
      `  ${String(index + 1)}) ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)
    return `${[prompt.message, ...options].join('\n')}\nChoose 1-${String(prompt.options.length)}: `
  }
  return prompt.placeholder === undefined ? `${prompt.message}: ` : `${prompt.message} (e.g. ${prompt.placeholder}): `
}

/**
 * Map a typed selection to the chosen option's id.
 * @param prompt - the select prompt.
 * @param answer - the typed option number or id.
 * @returns the option id.
 * @throws when the answer names no offered option.
 */
function selectedOption(prompt: Extract<AuthorizationPrompt, { kind: 'select' }>, answer: string): string {
  const typed = answer.trim()
  const byNumber = /^\d+$/u.test(typed) ? prompt.options[Number(typed) - 1] : undefined
  const chosen = byNumber ?? prompt.options.find(option => option.id === typed)
  if (chosen === undefined) throw new Error(`"${typed}" is not one of the offered options`)
  return chosen.id
}

/**
 * The process's own terminal. A prompt needs an interactive stdin: without
 * one it is declined, so a scripted `dsh auth login` fails instead of waiting
 * for input that cannot arrive.
 * @returns the terminal over stdin, stdout, and stderr.
 */
function processTerminal(): AuthTerminal {
  const fail = (line: string): void => { process.stderr.write(`${line}\n`) }
  return {
    print: (line) => { process.stdout.write(`${line}\n`) },
    fail,
    onInterrupt(listener) {
      process.on('SIGINT', listener)
      return () => { process.off('SIGINT', listener) }
    },
    async ask(prompt) {
      if (!process.stdin.isTTY) {
        fail(`dsh auth: cannot ask "${prompt.message}": stdin is not a terminal`)
        throw new AuthorizationDeclinedError('stdin is not a terminal')
      }
      const answer = await readLine(questionText(prompt), prompt.kind === 'secret', prompt.signal)
      return prompt.kind === 'select' ? selectedOption(prompt, answer) : answer.trim()
    },
  }
}

/**
 * Read one line from the terminal.
 * @param question - the text shown before the cursor.
 * @param mute - whether typed characters are hidden.
 * @param signal - withdraws the question.
 * @returns the typed line.
 * @throws {AuthorizationDeclinedError} on Ctrl+C or end of input; the signal's reason when withdrawn.
 */
function readLine(question: string, mute: boolean, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    // Readline echoes through its output stream, so a muted question writes
    // its text directly and gives readline an output that discards the echo.
    const output = mute ? new Writable({ write: (_chunk, _encoding, done) => { done() } }) : process.stdout
    const lines = createInterface({ input: process.stdin, output, terminal: true })
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', withdraw)
      lines.close()
      if (mute) process.stdout.write('\n')
      finish()
    }
    const withdraw = (): void => {
      const reason: unknown = signal?.reason
      settle(() => { reject(reason instanceof Error ? reason : new Error('the prompt was withdrawn')) })
    }
    signal?.addEventListener('abort', withdraw, { once: true })
    // Raw mode turns Ctrl+C into this event instead of a process signal.
    lines.on('SIGINT', () => { settle(() => { reject(new AuthorizationDeclinedError('the prompt was interrupted')) }) })
    lines.on('close', () => { settle(() => { reject(new AuthorizationDeclinedError('input ended before an answer')) }) })
    if (mute) process.stdout.write(question)
    lines.question(mute ? '' : question, (answer) => { settle(() => { resolve(answer) }) })
  })
}
