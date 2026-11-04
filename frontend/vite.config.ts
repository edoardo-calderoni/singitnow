import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const backend = "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        remote: resolve(__dirname, "remote.html"),
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": backend,
      "/media": backend,
      "/ws": { target: backend, ws: true },
    },
  },
});
