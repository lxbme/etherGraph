import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev backend; its auth.public_origin is this origin (the default config).
const API = 'http://127.0.0.1:8080'

/** The few http-proxy event types used here (its typings need @types/node, which this package does not have). */
interface ProxyEvents {
  on(
    event: 'proxyReq',
    fn: (proxyReq: { setHeader(name: string, value: string): void }, req: { headers: Record<string, string | string[] | undefined> }) => void,
  ): void
}

/** Whether `origin` is the dev server the request was sent to (`host`: the incoming Host header). */
function isOwnOrigin(origin: string | string[], host: string | string[] | undefined): boolean {
  return typeof origin === 'string' && typeof host === 'string' && (origin === `http://${host}` || origin === `https://${host}`)
}

// /api 代理到后端；SSE 需要流式透传，不能缓冲响应。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // The backend accepts state-changing requests (login included) only with Origin equal to its
        // public_origin. A request from the dev page itself (Origin = this dev server's own origin, i.e.
        // the Host it was sent to) is given the backend's origin instead, so dev login works with the
        // default config; any other Origin passes through untouched and the backend still rejects it.
        // Dev server only: production serves the app from the backend itself.
        configure: (proxy) => {
          ;(proxy as unknown as ProxyEvents).on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin
            if (origin !== undefined && isOwnOrigin(origin, req.headers.host)) proxyReq.setHeader('origin', API)
          })
        },
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
            // The wallet sign-in libraries, in two chunks under the 500 kB warning: viem with its crypto and
            // encoding dependencies, and wagmi + RainbowKit's UI. RainbowKit loads its wallet/chain icons
            // and locales on demand (its dist files other than index.js and the shared chunk-*.js): they
            // match no group, so they stay lazy chunks.
            { name: 'wallet-viem', test: /node_modules[\\/](viem|ox|abitype|@noble|@scure|@adraffy|isows)[\\/]/ },
            {
              name: 'wallet-ui',
              test: /node_modules[\\/](@rainbow-me[\\/]rainbowkit[\\/]dist[\\/](index\.js|chunk-)|(wagmi|@wagmi|mipd|@vanilla-extract|use-sync-external-store|react-remove-scroll[^\\/]*|react-style-singleton|use-callback-ref|use-sidecar|cuer|qr|ua-parser-js|clsx|eventemitter3)[\\/])/,
            },
            { name: 'vendor', test: /node_modules[\\/](?!@rainbow-me[\\/]rainbowkit[\\/]dist[\\/])/ },
          ],
        },
      },
    },
  },
})
