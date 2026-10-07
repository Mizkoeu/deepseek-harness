# Agent Note: Web app home-screen icon set

Status: implemented

English | [中文](2026-08-19-web-app-icon-set.zh.md)

## Problem

The Web app's only icons were the light and dark `favicon.svg` / `favicon-dark.svg` tab favicons: a transparent monochrome whale selected by `prefers-color-scheme` media links. Adding the app to an iPhone Home Screen produced a poor icon: iOS Safari does not rasterize an SVG favicon for the Home Screen and takes its image from a raster `apple-touch-icon`; without one it substitutes a generated image. The install manifest had the same gap on other platforms: its only icon was the transparent black whale, which reads as a black glyph on a launcher's own background and offers no maskable variant.

## Decision

The Web app ships a raster home-screen icon set beside the unchanged tab favicons. Tab favicons and home-screen icons are separate roles: the tab keeps the media-selected light/dark whale, and every installed or Home Screen surface uses one opaque tile mark.

- **The mark** is a brand-blue (`#3964FE`) tile carrying two white square brackets around a white center node. Its geometry stays legible from a 180px Home Screen icon down to small launcher sizes, and the tile supplies its own background, so it needs no color-scheme variant.
- **`apple-touch-icon.png`** (180×180, opaque full-bleed square; iOS applies its own corner mask) gives iOS Safari a crisp Home Screen image. `index.html` links it with `<link rel="apple-touch-icon">` and sets `apple-mobile-web-app-title` to `DSH`, matching the manifest `short_name`, so the Home Screen label does not depend on the build-time document title.
- **`icon-192.png` / `icon-512.png`** (rounded tile on transparency, `purpose: any`) and **`icon-maskable-512.png`** (opaque full-bleed, `purpose: maskable`, glyph inside the 40%-radius safe zone) are the manifest's complete icon list. The manifest does not list `favicon.svg`, so a browser cannot pick the transparent whale over the tile for an installed icon.
- Every reference is document-relative under the [document-relative routes decision](../architecture/2026-09-14-web-document-relative-app-routes.md): manifest `src` values are bare file names resolved against the manifest URL, and the `index.html` source paths are root-absolute only because Vite rewrites them to `./` under `base: './'`. The icons therefore resolve under any proxy mount.

`apps/web/scripts/generate-icons.mjs` is the mark's source of truth. It renders the tile SVG through the Playwright Chromium already declared as an `apps/web` devDependency and writes only the four PNGs; it never touches the tab favicons. Edit the script and rerun it from `apps/web` rather than editing the PNGs.

The PNGs live in `apps/web/public/`, which Vite copies into `dist/`; the `@deepseek-ai/dsh-web-frontend` package ships `dist` through its `files` list, so the `dsh web` static server serves them from the installed package. `@deepseek-ai/dsh-host-frontend-static` maps `.png` to `image/png`; without that entry the icons would ship as `application/octet-stream`. Non-index assets stay public under the static server, so iOS can fetch the icon without the browser-authentication cookie.

No static `theme-color` meta, `theme_color`, or `background_color` is added: the `dsh-client-ui-layout` theme presenter writes `meta[name="theme-color"]` at runtime from the resolved light or dark palette, and a fixed value would disagree with one of them. No `apple-mobile-web-app-capable` meta is added: iOS reads the linked manifest's `display` member for the Home Screen launch presentation, so the legacy meta would duplicate it.

## Alternatives considered

- **Reuse the whale favicon for the Home Screen.** Rejected: iOS needs a raster `apple-touch-icon`, and a transparent monochrome glyph rasterized onto a platform background loses the mark; the whale's fine detail also degrades at launcher sizes.
- **Replace the tab favicons with the tile.** Rejected: the media-selected light/dark whale is the tab identity, and the tile is needed only where a platform renders an opaque icon. Keeping the roles separate leaves the tab favicons unchanged.
- **Keep `favicon.svg` as an additional `any` manifest icon.** Rejected: a browser may select an SVG of size `any` for an installed icon, which would surface the transparent whale instead of the tile and give installed surfaces two different marks.
- **Add `<link rel="icon" type="image/png">` rows for the PNGs.** Rejected: unqualified PNG icon rows compete with the media-qualified SVG favicons in browser tabs.
- **Own the icons through the deployment branding slots (`dsh-client-ui-brand-official`).** Rejected: those slots occupy React UI (the sidebar brand) after the shell boots, while the browser and iOS read icon links and the manifest from the static document before any plugin runs. The tab favicons and manifest are likewise static build assets, so the home-screen icons follow them; a differently branded deployment replaces the files in `apps/web/public/`.
- **Commit only the PNGs, no generator.** Rejected: the mark must stay editable and reproducible from one source.

## Consequences

- Adding the Web app to an iPhone Home Screen or installing it as a PWA yields a crisp tile icon labeled `DSH`; browser tabs keep the light/dark whale favicons.
- The tab and installed surfaces carry different marks by design; a future single-mark identity changes the favicons and the generator together.
- Branding is not per deployment: like the favicons and manifest, the icon set is fixed in the built `dist/`, independent of `DSH_CLIENT_BUILD_PROFILE` and `DSH_CLIENT_TITLE`.
- The `.png` MIME entry takes effect only after the serving `dsh web` process restarts, because a running server holds the loaded module.
- iOS caches a Home Screen icon when the bookmark is created; an existing bookmark keeps its old image until it is removed and added again.

## Testing

`apps/web/tests/pwa-manifest.e2e.ts` reads the built `dist/` and pins the full manifest object including the three icon entries, the `apple-touch-icon` link and `apple-mobile-web-app-title` meta in the emitted `index.html`, and each PNG's signature, dimensions, and opaque-RGB versus transparent-RGBA color type. It runs in the keyless `vitest.web.config.ts` lane after a build. The `dsh-host-frontend-static` real Loader composition test serves a `.png` fixture and pins its `image/png` media type.
