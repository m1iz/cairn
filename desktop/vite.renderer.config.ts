import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const repoRoot = resolve(__dirname, '..')

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
  },
  server: {
    fs: { allow: [repoRoot] },
  },
})
