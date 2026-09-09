# Agent Note: Web app icon set — bracketed-agent mark and iOS-crisp PNGs

Status: implemented

English | [中文](2026-08-19-web-app-icon-set.zh.md)

## Problem

The Web app shipped a single `favicon.svg` — the DeepSeek whale logo — as its only icon, referenced by `index.html` and the PWA manifest. On iOS Safari, adding the app as a Home Screen bookmark produced a blurry, low-resolution icon: iOS does not rasterize an SVG favicon for the Home Screen and needs a raster `apple-touch-icon`; with none present it scaled a small fallback. The whale mark also carried fine detail that degraded at 16–32px tab sizes, and it did not communicate what the product is.

## Decision

The app ships a small geometric mark rendered as a full icon set:

- **The mark** is a rounded brand-blue (`#3964fe`, `--dsw-alias-brand-primary`) tile carrying two white square brackets around a white center node. The brackets read as the *harness* that wraps and controls; the node reads as the *agent* being run. The geometry stays legible from a 16px tab to a 180px Home Screen icon. The tile carries its own opaque background, so the icon no longer depends on a `prefers-color-scheme` fill swap to survive dark tab bars (superseding the earlier dark-mode-favicon fix, now archived).
- **`apps/web/public/favicon.svg`** is the resolution-independent primary icon (rounded tile).
- **`apple-touch-icon.png`** (180×180, full-bleed square — iOS applies its own corner mask) gives iOS Safari a crisp Home Screen raster. `index.html` links it and sets `apple-mobile-web-app-title` to `DSH` for the Home Screen label.
- **`icon-192.png` / `icon-512.png`** (rounded, `purpose: any`) and **`icon-maskable-512.png`** (full-bleed, `purpose: maskable`) are declared in `manifest.webmanifest`. The manifest keeps deliberately omitting `theme_color` and `background_color` per the [install-manifest decision](2026-08-06-web-install-manifest.md): a static color disagrees with one of the runtime-resolved light/dark palettes.

The PNGs are regenerated from the same geometry by `apps/web/scripts/generate-icons.mjs`, which rasterizes the SVG through the Playwright Chromium already vendored as an `apps/web` devDependency — no new image toolchain. The mark's source of truth is that script; edit it and rerun, do not hand-edit the PNGs.

`@deepseek-ai/dsh-host-frontend-static` served `.png` as `application/octet-stream` because its starter MIME table omitted the extension. Now that PNG icons ship, the table maps `.png` → `image/png`; the package's real-composition test asserts it and the READMEs list PNG in the covered asset set.

## Alternatives considered

- **Scale the existing whale.** Rejected: the detail does not survive small sizes, and an SVG-only favicon still leaves iOS without a raster Home Screen icon.
- **SVG-only, no PNGs.** Rejected: iOS Safari does not use an SVG for the Home Screen, which is the exact surface the user reported as blurry.
- **Commit only the PNGs, no generator.** Rejected: the mark must stay editable and reproducible; a committed generator keeps the raster set derivable from one source.
- **Keep the transparent monochrome glyph with a dark-mode fill swap.** Rejected: a self-contained colored tile is simpler and reads consistently on both light and dark tab bars and as a masked Home Screen icon.

## Consequences

- iOS Home Screen and PWA installs get a crisp, on-brand icon; browser tabs get a mark that survives small sizes and states the product's identity.
- The `.png` MIME addition is a one-line table entry covered by the existing real-composition test; it takes effect only after the serving `dsh web` process restarts, since the running server holds the previously loaded module.
- The icon set is five raster files plus one SVG, all regenerable from `generate-icons.mjs`; drift is avoided by treating the script as the source.

## Related

- Supersedes the archived dark-mode-favicon fix (`archived/bug-fix/2026-08-10-web-favicon-dark-mode.md`): the new self-backed tile removes the need for the `prefers-color-scheme` fill swap.
