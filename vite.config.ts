import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
  },
});
