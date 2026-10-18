import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev backend; its auth.public_origin is this origin (the default config).
const API = 'http://127.0.0.1:8080'

// /api 代理到后端；SSE 需要流式透传，不能缓冲响应。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // The backend accepts state-changing requests (login included) only with Origin equal to its
        // public_origin. The dev page's origin (localhost:5173) differs, so every proxied request carries
        // the backend's own origin instead and dev login works with the default config. Dev server only:
        // production serves the app from the backend itself.
        headers: { origin: API },
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
            // RainbowKit loads its wallet/chain icons and locales on demand (its dist files other than
            // index.js and the shared chunk-*.js): left out of the vendor group, they stay lazy chunks.
            { name: 'vendor', test: /node_modules[\\/](?!@rainbow-me[\\/]rainbowkit[\\/]dist[\\/](?!index\.js|chunk-))/ },
          ],
        },
      },
    },
  },
})
