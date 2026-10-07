import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'

/** Rewrites the installed github-copilot model list for one case; identity by default. */
const copilotShipped = vi.hoisted(() => ({
  rewrite: (models: Model<Api>[]): Model<Api>[] => models,
}))

vi.mock('@earendil-works/pi-ai/providers/all', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>()
  return {
    ...actual,
    getBuiltinModels: (provider: Parameters<typeof actual.getBuiltinModels>[0]) => {
      const models = actual.getBuiltinModels(provider) as Model<Api>[]
      return provider === 'github-copilot' ? copilotShipped.rewrite(models) : models
    },
  }
})

const { catalogModels } = await import('../src/catalog.ts')
const { resolveProfiles } = await import('../src/config.ts')

afterEach(() => {
  copilotShipped.rewrite = models => models
})

describe('uncataloged catalog models', () => {
  it.each([
    { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', cloneOf: 'claude-sonnet-5' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', cloneOf: 'gpt-6-sol' },
  ])('serves $id on the github-copilot route as a renamed copy of $cloneOf', ({ id, name, cloneOf }) => {
    const models = catalogModels('github-copilot')
    const clone = models.get(id)
    const sibling = models.get(cloneOf)

    expect(sibling).toBeDefined()
    expect(clone?.name).toBe(name)
    // The protocol, Copilot request headers, compat, and reasoning map are
    // the sibling's, because no profile field can restate them per model.
    expect({ ...clone, id: sibling?.id, name: sibling?.name }).toEqual(sibling)
  })

  it('reaches the served route without any profile configuration', () => {
    const route = resolveProfiles({ 'github-copilot': {} }).get('github-copilot')

    expect(route?.piProvider?.getModels().map(model => model.id))
      .toEqual(expect.arrayContaining(['claude-sonnet-5.5', 'gpt-6.1-sol']))
  })

  it('keeps the shipped descriptor once the installed catalog describes the model', () => {
    copilotShipped.rewrite = models => [
      ...models,
      { ...models.find(model => model.id === 'claude-sonnet-5')!, id: 'claude-sonnet-5.5', name: 'Shipped', maxTokens: 7 },
    ]

    const sonnet = catalogModels('github-copilot').get('claude-sonnet-5.5')

    expect(sonnet).toMatchObject({ name: 'Shipped', maxTokens: 7 })
  })

  it('omits a clone whose sibling the installed catalog no longer ships', () => {
    copilotShipped.rewrite = models => models.filter(model => model.id !== 'gpt-6-sol')

    const models = catalogModels('github-copilot')

    expect(models.has('gpt-6.1-sol')).toBe(false)
    expect(models.has('claude-sonnet-5.5')).toBe(true)
  })

  it('adds nothing to an unrelated catalog route', () => {
    expect(catalogModels('anthropic').has('claude-sonnet-5.5')).toBe(false)
    expect(catalogModels('openai').has('gpt-6.1-sol')).toBe(false)
  })
})
