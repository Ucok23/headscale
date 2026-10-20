import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The UI is served by headscale under /admin/ (embedded in the Go binary).
// In dev, API calls are proxied to a local headscale.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
})
