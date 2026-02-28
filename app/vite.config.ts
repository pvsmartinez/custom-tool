/// <reference types="vitest" />
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

  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
    },
  },

  define: {
    // Makes __PROJECT_ROOT__ available in all frontend files
    __PROJECT_ROOT__: JSON.stringify(projectRoot),
  },

  build: {
    // Raise the warning threshold slightly — tldraw is inherently large;
    // we split it out but don't want a warning for the tldraw chunk itself.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // tldraw — largest single dep (~1.5 MB unminified)
          if (id.includes('node_modules/tldraw') ||
              id.includes('node_modules/@tldraw')) {
            return 'vendor-tldraw';
          }
          // CodeMirror editor stack
          if (id.includes('node_modules/@codemirror') ||
              id.includes('node_modules/@uiw/react-codemirror') ||
              id.includes('node_modules/@lezer')) {
            return 'vendor-codemirror';
          }
          // React core
          if (id.includes('node_modules/react') ||
              id.includes('node_modules/react-dom') ||
              id.includes('node_modules/scheduler')) {
            return 'vendor-react';
          }
          // Tauri plugins
          if (id.includes('node_modules/@tauri-apps')) {
            return 'vendor-tauri';
          }
          // Markdown / front-matter helpers
          if (id.includes('node_modules/marked') ||
              id.includes('node_modules/gray-matter') ||
              id.includes('node_modules/js-yaml')) {
            return 'vendor-content';
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
