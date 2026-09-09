import { describe, expect, it, vi } from 'vitest'
import type { AuthInteraction } from '@earendil-works/pi-ai'

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai', async importOriginal => ({
  ...await importOriginal<typeof import('@earendil-works/pi-ai')>(),
  createModels: () => ({
    setProvider: () => undefined,
    login: mocks.login,
  }),
}))

import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { loginGitHubCopilot } from '../src/auth.ts'

describe('GitHub Copilot auth prompts', () => {
  it('rejects a provider prompt the terminal command cannot answer', async () => {
    mocks.login.mockImplementationOnce(async (_provider: string, _type: string, interaction: AuthInteraction) => {
      await interaction.prompt({ type: 'secret', message: 'unexpected secret' })
    })

    await expect(loginGitHubCopilot({
      notify: () => undefined,
    }, new InMemoryCredentialStore())).rejects.toThrow(/unsupported prompt type "secret"/)
  })

  it('rejects a second prompt instead of reusing the enterprise answer', async () => {
    mocks.login.mockImplementationOnce(async (_provider: string, _type: string, interaction: AuthInteraction) => {
      await interaction.prompt({ type: 'text', message: 'enterprise domain' })
      await interaction.prompt({ type: 'text', message: 'unexpected second value' })
    })

    await expect(loginGitHubCopilot({
      enterpriseDomain: 'ghe.example',
      notify: () => undefined,
    }, new InMemoryCredentialStore())).rejects.toThrow(/unsupported prompt type "text"/)
  })
})
