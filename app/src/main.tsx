import React from "react";
import ReactDOM from "react-dom/client";
/* ── Bundled fonts (no network required in Tauri) ── */
import '@fontsource-variable/nunito';          /* UI: 300–900, wght axis */
import '@fontsource/vollkorn/400.css';         /* Serif: regular */
import '@fontsource/vollkorn/400-italic.css';  /* Serif: italic */
import '@fontsource/vollkorn/600.css';         /* Serif: semibold */
import '@fontsource/fira-code/400.css';        /* Mono: regular */
import '@fontsource/fira-code/500.css';        /* Mono: medium */
import App from "./App";
import MobileApp from "./MobileApp";

// Detect mobile: running in a narrow viewport (iOS/Android simulator or device)
// `VITE_TAURI_MOBILE=true` can also be set explicitly in the tauri ios/android
// build pipeline for an unambiguous signal.
const isMobile =
  import.meta.env.VITE_TAURI_MOBILE === 'true' ||
  (typeof window !== 'undefined' && window.innerWidth <= 600 && 'ontouchstart' in window);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMobile ? <MobileApp /> : <App />}
  </React.StrictMode>,
);
