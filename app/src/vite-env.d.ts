/// <reference types="vite/client" />

// Injected by vite.config.ts — absolute path to the project root at build time
declare const __PROJECT_ROOT__: string;

interface ImportMetaEnv {
  readonly VITE_TAURI_MOBILE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
