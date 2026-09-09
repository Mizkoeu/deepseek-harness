/**
 * Guards the shipped web composition's directory-picker default: the effective
 * dsh-base + dsh-web-app rows mount the in-app `-browse` picker (host
 * `directory-picker-browse` + client `ui-directory-picker-browse`), not the
 * native OS chooser or the `-auto` chooser.
 *
 * This is the only host-independent guard for that decision. The native chooser
 * opens on the server's own display and `-auto` samples the boot-time bind host
 * and platform to decide — on a loopback-bound darwin/win32 host it resolves
 * `native`. Both are undriveable from the remote browser the GUI is reached
 * from: the web app binds loopback only (`--host 0.0.0.0` is refused), so every
 * non-local client arrives through a tunnel. The browser e2e lane cannot catch a
 * regression here — it runs on Linux CI without a chooser binary, where `-auto`
 * itself resolves `browse` and passes.
 *
 * The assertion runs over `composeEntries`, the real base+surface layering, so
 * it reflects the effective mounted rows after the web patch overrides base by
 * id — not raw `insert` presence in one file.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const BASE_PATCH_PATH = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const WEB_PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** Every plugin package name the effective base+web composition mounts. */
function composedPackageNames(): string[] {
  const basePatches = loadOverlayPatches('web-app bundle test', BASE_PATCH_PATH)
  const webPatches = loadOverlayPatches('web-app bundle test', WEB_PATCH_PATH)
  const names: string[] = []
  for (const row of composeEntries([basePatches, webPatches])) {
    if (typeof row.name === 'string') names.push(row.name)
  }
  return names
}

describe('web-app bundle directory picker', () => {
  it('mounts the in-app -browse picker (host + client), so a remote browser can pick a folder', () => {
    const names = composedPackageNames()
    expect(names).toContain('@deepseek-ai/dsh-host-directory-picker-browse')
    expect(names).toContain('@deepseek-ai/dsh-client-ui-directory-picker-browse')
  })

  it('never ships the native OS chooser or the -auto chooser', () => {
    const names = composedPackageNames()
    expect(names).not.toContain('@deepseek-ai/dsh-host-directory-picker-auto')
    expect(names).not.toContain('@deepseek-ai/dsh-host-directory-picker-native')
    expect(names).not.toContain('@deepseek-ai/dsh-client-ui-directory-picker-native')
  })
})
