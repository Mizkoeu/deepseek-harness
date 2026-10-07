/**
 * Regenerate the Web app's raster home-screen and install icons from one geometric mark.
 *
 * The mark is a brand-blue (`#3964FE`) tile carrying two white square brackets around a white
 * center node. This script is the mark's source of truth; edit it and rerun rather than editing
 * the PNGs. It writes only the raster set into `../public`; the light and dark tab favicons
 * (`favicon.svg`, `favicon-dark.svg`) are separate assets this script never touches.
 *
 * Outputs:
 * - `apple-touch-icon.png` 180x180 opaque full-bleed square; iOS applies its own corner mask.
 * - `icon-192.png` and `icon-512.png` rounded tile on transparency, manifest purpose `any`.
 * - `icon-maskable-512.png` opaque full-bleed square, manifest purpose `maskable`; the glyph
 *   stays inside the 40%-radius safe zone.
 *
 * PNGs are rasterized by the Playwright Chromium already declared as an `apps/web`
 * devDependency. Run from `apps/web`: `node scripts/generate-icons.mjs`.
 */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRAND = '#3964FE'
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * Build the mark as an SVG document on a 512 canvas.
 * @param {boolean} rounded - Rounded tile for a standalone icon; a full-bleed square for slots the platform masks.
 * @returns {string} SVG document text.
 */
function markSvg(rounded) {
  const corner = rounded ? ' rx="114"' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
  <rect width="512" height="512"${corner} fill="${BRAND}"/>
  <g stroke="#FFFFFF" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M182 130 H140 V382 H182"/>
    <path d="M330 130 H372 V382 H330"/>
  </g>
  <circle cx="256" cy="256" r="52" fill="#FFFFFF"/>
</svg>
`
}

const targets = [
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, rounded: false },
]

const browser = await chromium.launch()
try {
  for (const { file, size, rounded } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    const source = 'data:image/svg+xml;base64,' + Buffer.from(markSvg(rounded)).toString('base64')
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${source}"></body></html>`,
    )
    await page.locator('img').waitFor()
    // Only the rounded tile has transparent corners; full-bleed squares stay opaque.
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: rounded })
    await writeFile(join(publicDir, file), png)
    await page.close()
    console.log(`wrote public/${file} (${size}x${size})`)
  }
} finally {
  await browser.close()
}
