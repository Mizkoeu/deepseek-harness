import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  // iOS Safari needs a raster apple-touch-icon for a crisp Home Screen bookmark;
  // an SVG favicon alone rasterizes poorly there.
  expect(index).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('ships a self-backed geometric favicon that reads on light and dark tab bars', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  // The mark carries its own opaque brand tile and a white glyph, so it no
  // longer depends on a prefers-color-scheme fill swap to survive dark chrome.
  expect(favicon).toContain('fill="#3964FE"')
  expect(favicon).toContain('rx="114"')
  expect(favicon).toContain('stroke="#FFFFFF"')
  expect(favicon).not.toContain('prefers-color-scheme')
})
