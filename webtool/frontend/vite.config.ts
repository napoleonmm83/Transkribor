import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { APP_VERSION } from './version.config.ts'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  // Gegenstueck in vitest.config.ts — beide brauchen es, siehe version.config.ts.
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  build: { outDir: path.resolve(__dirname, '../static'), emptyOutDir: true },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
})
