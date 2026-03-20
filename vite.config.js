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
    // FIX: Vite v8 (rolldown) requires manualChunks as a FUNCTION, not an object
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vendor chunk — React + Router (cached separately by browser)
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) {
            return 'vendor';
          }

          // Heavy canvas chart — only loads on market/crypto pages
          if (id.includes('CandlestickChart')) {
            return 'chart';
          }

          // Heavy pages — load only when visited
          if (id.includes('/pages/Dashboard'))    return 'dashboard';
          if (id.includes('/pages/Market'))       return 'market';
          if (id.includes('/pages/Crypto'))       return 'crypto';
          if (id.includes('/pages/Stocks'))       return 'stocks';
          if (id.includes('/pages/Analytics'))    return 'analytics';
          if (id.includes('/pages/Settings'))     return 'settings';
          if (id.includes('/pages/Community'))    return 'community';
          if (id.includes('/pages/PostGenerator')) return 'post';
        },
      },
    },

    chunkSizeWarningLimit: 600,
    cssMinify: true,
    minify: 'esbuild',
    sourcemap: false,
  },
})
