/// <reference types="vite/client" />

// Injected by vite.config.ts — absolute path to the project root at build time
declare const __PROJECT_ROOT__: string;

interface ImportMetaEnv {
  readonly VITE_TAURI_MOBILE?: string;
  /** Automatically injected by Tauri v2: darwin | linux | windows | ios | android */
  readonly TAURI_ENV_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
