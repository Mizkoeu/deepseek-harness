// Built-consumer surface guard: source-plane tsconfig paths and pnpm workspace
// hoisting let this package's tests pass even when its published manifest omits
// an export, a shipped file, or a dependency — so a built consumer (apps/cli
// imports `@deepseek-ai/dsh-llm-pi-ai/auth`) breaks while the source suite stays
// green. These assertions read the manifest directly, no build required.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Manifest {
  name: string
  exports: Record<string, unknown>
  files: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Manifest
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** Every `.ts` file under `src/`. */
function sourceFiles(): string[] {
  return readdirSync(new URL('../src/', import.meta.url), { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
    .map(entry => fileURLToPath(new URL(`../src/${entry}`, import.meta.url)))
}

/** Bare package names imported by one source (relative and `node:` specifiers excluded). */
function importedPackages(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const spec = match[1]!
    if (spec.startsWith('.') || spec.startsWith('node:')) continue
    names.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!)
  }
  return names
}

describe('llm-pi-ai published surface', () => {
  it('declares every external package its sources import, so a built consumer resolves them', () => {
    const missing = new Set<string>()
    for (const file of sourceFiles()) {
      for (const name of importedPackages(readFileSync(file, 'utf8'))) {
        if (name !== manifest.name && !declared.has(name)) missing.add(name)
      }
    }
    expect([...missing].sort()).toEqual([])
  })

  it('exports and ships the built ./auth entry the CLI imports', () => {
    expect(manifest.exports['./auth']).toEqual({ types: './lib/types/auth.d.ts', default: './lib/auth.js' })
    expect(manifest.files).toContain('lib/auth.js')
    expect(readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')).toMatch(/lib\/types\/auth\.js/)
  })
})
