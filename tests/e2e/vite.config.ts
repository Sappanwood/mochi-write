import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: resolve("tests/e2e/browser"),
  plugins: [react()],
  build: { outDir: resolve(".data/browser"), emptyOutDir: true },
});
