import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api 代理到后端；SSE 需要流式透传，不能缓冲响应。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
