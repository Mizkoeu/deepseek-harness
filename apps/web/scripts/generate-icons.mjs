// Regenerate the Web app icon set from one geometric source mark.
//
// The mark: a rounded brand-blue tile carrying two white square brackets (the
// "harness" that wraps and controls) around a white center node (the agent).
// Simple geometry so it stays legible from a 16px browser tab up to a 180px
// iOS home-screen icon — the previous whale favicon rasterized poorly there.
//
// Outputs (written to ../public):
//   favicon.svg            rounded tile, the resolution-independent primary icon
//   apple-touch-icon.png   180x180 full-bleed square (iOS applies its own mask)
//   icon-192.png           192x192 rounded, manifest "any"
//   icon-512.png           512x512 rounded, manifest "any"
//   icon-maskable-512.png  512x512 full-bleed square, manifest "maskable"
//
// PNGs are rasterized through the Playwright Chromium already vendored as an
// apps/web devDependency, so no extra image toolchain is required. Run with:
//   node scripts/generate-icons.mjs   (from apps/web)
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRAND = '#3964FE'
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * Build the icon SVG at a fixed 512 canvas.
 * @param {boolean} rounded - true for a rounded tile (standalone icon), false
 *   for a full-bleed square (platform-masked apple-touch / maskable slots).
 * @returns {string} the SVG document text.
 */
function svg(rounded) {
  const tile = rounded
    ? `<rect width="512" height="512" rx="114" fill="${BRAND}"/>`
    : `<rect width="512" height="512" fill="${BRAND}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none" role="img" aria-label="DeepSeek Harness">
  ${tile}
  <g stroke="#FFFFFF" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M182 130 H140 V382 H182"/>
    <path d="M330 130 H372 V382 H330"/>
  </g>
  <circle cx="256" cy="256" r="52" fill="#FFFFFF"/>
</svg>
`
}

const roundedSvg = svg(true)
const squareSvg = svg(false)

await writeFile(join(publicDir, 'favicon.svg'), roundedSvg)

const targets = [
  { file: 'apple-touch-icon.png', size: 180, source: squareSvg, transparent: false },
  { file: 'icon-192.png', size: 192, source: roundedSvg, transparent: true },
  { file: 'icon-512.png', size: 512, source: roundedSvg, transparent: true },
  { file: 'icon-maskable-512.png', size: 512, source: squareSvg, transparent: false },
]

const browser = await chromium.launch()
try {
  for (const { file, size, source, transparent } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const url = 'data:image/svg+xml;base64,' + Buffer.from(source).toString('base64')
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${url}"></body></html>`,
    )
    await page.locator('img').waitFor()
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: transparent })
    await writeFile(join(publicDir, file), png)
    await page.close()
    console.log(`wrote public/${file} (${size}x${size})`)
  }
} finally {
  await browser.close()
}
console.log('wrote public/favicon.svg')
