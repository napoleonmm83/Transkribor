import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { APP_VERSION } from './version.config.ts'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // Gegenstueck in vite.config.ts — ohne den Wert wirft die StatusBar hier ReferenceError.
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/setupTests.ts'] },
})
