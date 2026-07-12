import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Farm OS",
        short_name: "Farm OS",
        description: "Self-hosted farm records — voice capture, fields, programs",
        theme_color: "#1b5e20",
        background_color: "#f6f5f0",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // App shell precache; API calls are network-only (the offline queue
        // in src/offline handles capture, not the service worker cache).
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/healthz/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: { "/api": "http://localhost:8585", "/healthz": "http://localhost:8585" },
  },
});
