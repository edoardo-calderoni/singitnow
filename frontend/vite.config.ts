import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// impronta dei video di avvio: entra nel loro indirizzo (?v=...), così quando un video viene rifatto
// il browser (anche la cache di WebView2) lo riscarica invece di mostrare quello vecchio
const splashHash = createHash("sha1");
for (const name of ["splash.mp4", "splash-mobile.mp4"]) splashHash.update(readFileSync(resolve(__dirname, "public", name)));
const SPLASH_V = splashHash.digest("hex").slice(0, 10);

const backend = "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  define: { __SPLASH_V__: JSON.stringify(SPLASH_V) },
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
