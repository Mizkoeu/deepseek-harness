import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('ships raster home-screen icons at their declared sizes', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  // iOS Safari takes the Home Screen image from apple-touch-icon and its label
  // from apple-mobile-web-app-title before falling back to the document title.
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  expect(index).toContain('<meta name="apple-mobile-web-app-title" content="DSH" />')

  // Platform-masked slots (iOS, maskable) are opaque RGB because a platform
  // paints transparent pixels with its own fill (black on iOS); the `any`
  // tiles keep transparent rounded corners.
  const icons: Array<[file: string, size: number, alpha: boolean]> = [
    ['apple-touch-icon.png', 180, false],
    ['icon-192.png', 192, true],
    ['icon-512.png', 512, true],
    ['icon-maskable-512.png', 512, false],
  ]
  for (const [file, size, alpha] of icons) {
    const png = await readFile(join(DIST_ROOT, file))
    expect(png.subarray(0, 8), file).toEqual(PNG_SIGNATURE)
    // IHDR follows the signature: width, height, bit depth, then color type (2 RGB, 6 RGBA).
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], file).toEqual([size, size, alpha ? 6 : 2])
  }
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#000"')
  expect(dark).toContain('fill="#fff"')
  expect(dark.replace('fill="#fff"', 'fill="#000"')).toBe(light)
})
