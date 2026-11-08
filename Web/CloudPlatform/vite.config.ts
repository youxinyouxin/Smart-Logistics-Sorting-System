import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = process.env.API_PROXY_TARGET || env.API_PROXY_TARGET || 'http://127.0.0.1:81'
  const sorterTarget =
    process.env.SORTER_PROXY_TARGET || env.SORTER_PROXY_TARGET || 'http://192.168.1.102:82'

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
        '/sorter': {
          target: sorterTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/sorter/, ''),
        },
      },
    },
    preview: {
      host: true,
      port: 4173,
    },
    build: {
      chunkSizeWarningLimit: 1800,
    },
  }
})
