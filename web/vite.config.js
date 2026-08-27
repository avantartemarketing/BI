import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  build: { outDir: path.resolve(__dirname, "dist"), emptyOutDir: true },
  server: {
    proxy: { "/api": "http://localhost:10000" },
    fs: { allow: [path.resolve(__dirname, "..")] },
  },
});
