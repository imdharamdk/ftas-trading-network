import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      "/api": "http://localhost:5000",
    },
  },

  build: {
    // Code splitting — each page becomes a separate chunk
    // Browser only downloads the page the user is actually visiting
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunk — React + Router (cached separately by browser)
          vendor: ['react', 'react-dom', 'react-router-dom'],

          // Heavy pages — load only when visited
          dashboard:  ['./src/pages/Dashboard.jsx'],
          market:     ['./src/pages/Market.jsx'],
          crypto:     ['./src/pages/Crypto.jsx'],
          stocks:     ['./src/pages/Stocks.jsx'],
          analytics:  ['./src/pages/Analytics.jsx'],
          settings:   ['./src/pages/Settings.jsx'],
          community:  ['./src/pages/Community.jsx'],
          post:       ['./src/pages/PostGenerator.jsx'],

          // Heavy component — candlestick chart only loads on market/crypto pages
          chart: ['./src/components/CandlestickChart.jsx'],
        },
      },
    },

    // Slightly larger warning threshold — chart canvas code is intentionally big
    chunkSizeWarningLimit: 600,

    // Minify CSS + JS
    cssMinify: true,
    minify: 'esbuild',

    // Source maps off in production (faster build, smaller output)
    sourcemap: false,
  },
})
