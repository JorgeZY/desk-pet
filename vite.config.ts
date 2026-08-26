import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/renderer",
  base: "./",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist-renderer"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
