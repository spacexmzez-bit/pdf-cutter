import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: { exclude: ["@lipoe/browser-qpdf"] },
  build: {
    target: "es2022",
    sourcemap: false
  },
  server: {
    host: "0.0.0.0"
  }
});
