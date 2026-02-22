import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Project root (parent of this app/ dir) — embedded at build time so the
// in-app Update button knows where to find the source.
// @ts-expect-error process is a nodejs global
const projectRoot = path.resolve(process.cwd(), "..");

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    // Makes __PROJECT_ROOT__ available in all frontend files
    __PROJECT_ROOT__: JSON.stringify(projectRoot),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
