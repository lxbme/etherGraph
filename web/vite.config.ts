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
  build: {
    rolldownOptions: {
      output: {
        // Cytoscape and its layout extensions are large; keep them out of the app chunk.
        codeSplitting: {
          groups: [
            { name: 'cytoscape', test: /node_modules[\\/]cytoscape[\\/]/ },
            { name: 'graph-layouts', test: /node_modules[\\/](cytoscape-[^\\/]+|layout-base|cose-base|dagre|graphlib|@dagrejs)[\\/]/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
})
