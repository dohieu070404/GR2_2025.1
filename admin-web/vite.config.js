import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Simple dev proxy so you can run:
// - backend: http://localhost:3000
// - admin-web: http://localhost:5173
// and avoid CORS issues.
export default defineConfig(() => {
  const target = process.env.VITE_API_PROXY_TARGET || "http://localhost:3000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        // IMPORTANT:
        // Do NOT proxy "/". If we proxy the root path then the Vite dev server
        // will forward the SPA entry (/) to backend → you will see 404.
        // Only proxy API routes.
        "/auth": { target, changeOrigin: true },
        "/me": { target, changeOrigin: true },
        "/admin": { target, changeOrigin: true },
        "/homes": { target, changeOrigin: true },
        "/hubs": { target, changeOrigin: true },
        "/devices": { target, changeOrigin: true },
        "/automations": { target, changeOrigin: true }
      }
    }
  };
});
