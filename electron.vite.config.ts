import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') }
    }
  },
  renderer: {
    root: 'src',
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/index.html') }
    }
  }
})
