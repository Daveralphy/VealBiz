import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Ports can be moved (the end-to-end tests run on their own ports beside `pnpm dev`).
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: `http://localhost:${process.env.API_PORT ?? 4000}`, changeOrigin: false } },
  },
});
