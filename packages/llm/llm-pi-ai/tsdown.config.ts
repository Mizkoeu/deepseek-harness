import { defineConfig } from 'tsdown'

/** Emit the plugin, invariant, and setup-auth entry points. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/auth.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
