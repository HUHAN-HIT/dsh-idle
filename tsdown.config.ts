import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: true,
  // package.json main/exports point at lib/index.js — keep the emitted extension in sync.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
