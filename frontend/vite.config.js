import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dev server proxies /api to the Express backend, so the browser sees one origin
// (session cookies stay SameSite=Strict). host: true also serves on your LAN IP so a
// phone on the same Wi-Fi can open QR links.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false } },
  },
})
