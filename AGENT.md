# AGENT.md — Project Context for AI Sessions

> **Two audiences for this file:**
> - **GitHub Copilot in VS Code** — building and maintaining this codebase. Use the full file.
> - **In-app Copilot assistant** — helping the user with their workspace content. Focus on the "What this app does" and "Workspace behaviour" sections; ignore build/dev internals.

## Project: Cafezin

**Owner:** Pedro Martinez (pvsmartinez@gmail.com)  
**Repo:** https://github.com/pvsmartinez/custom-tool  
**Started:** February 2026  
**Last major session:** February 23, 2026

---

## What We Are Building

A general-purpose AI-assisted productivity tool, inspired by how Pedro uses VS Code + GitHub Copilot — but **not** focused on coding. Designed to support creative, educational, and knowledge-work workflows:

- ✍️ Writing books and long-form content  
- 📚 Creating classes, courses, and curricula  
- 🗂️ Knowledge management and note-taking  
- 🤖 AI-powered workflows for non-technical users  

---

## Target Platforms

| Platform | Priority | Notes |
|---|---|---|
| macOS (native app) | Primary | Pedro's daily driver |
| PC / Windows | Secondary | Cross-platform Tauri |
| Web app | Planned | Broader accessibility |
| iPhone / Android | Future | View-only + voice only (Phase 3) |

---

## Technical Stack

- **Framework:** Tauri v2 (Rust backend) + React 19 / TypeScript frontend (Vite)
- **Editor:** CodeMirror 6 (`@uiw/react-codemirror`) with Markdown language support
- **Canvas:** tldraw v4 — `.tldr.json` files; Frames = slides; full AI tool-calling integration
- **AI:** GitHub Copilot API (`https://api.githubcopilot.com`) — OpenAI-compatible, streamed via SSE
  - Auth: device flow OAuth — `startDeviceFlow()` / `getStoredOAuthToken()` in `copilot.ts`
  - Models fetched dynamically from `/models`; `FALLBACK_MODELS` used as fallback
  - Agent loop: `runCopilotAgent()` — tool-calling, MAX_ROUNDS=50, auto-continue prompt on exhaustion
  - Vision: canvas screenshot merged into user message for vision-capable models
  - Vision gating: `modelSupportsVision(id)` returns false for o-series models (`/^o\d/`)
- **Documents:** Markdown + YAML frontmatter (git-friendly, exportable)
- **Version control:** git per workspace, auto-init via Rust `git_init` command
- **In-app update:** `./scripts/update-app.sh` — incremental Cargo+Vite build → replaces `~/Applications/Cafezin.app`
- **Voice:** Web Speech API (`webkitSpeechRecognition`) — flat SVG mic/stop buttons in AIPanel footer
- **Preview:** `marked` library renders MD → HTML in `MarkdownPreview` component
- **PDF:** Tauri `convertFileSrc` + native WebKit `<embed type="application/pdf">`
- **Media:** Images/video via binary `readFile` + object URL (`MediaViewer.tsx`)
- **Image search:** Pexels API — downloads via `tauriFetch` to `workspace/images/`
- **AI marks:** `aiMarks.ts` tracks AI-written text regions; `AIMarkOverlay` shows chips; `AIReviewPanel` lists reviews
- **No backend server** — all data stays local; API calls go directly from WebView

---

## Project Structure

```
custom-tool/
├── app/                          # Tauri v2 app root
│   ├── src/
│   │   ├── components/
│   │   │   ├── Editor.tsx/css             # CodeMirror 6 Markdown editor with AI mark highlights
│   │   │   ├── CanvasEditor.tsx/css       # tldraw v4 — frames=slides, strip, drag-drop, context menu, format panel
│   │   │   ├── AIPanel.tsx/css            # Right-side Copilot chat panel (⌘K) — agent mode + vision
│   │   │   ├── AIMarkOverlay.tsx/css      # Floating chips over AI-marked text regions
│   │   │   ├── AIReviewPanel.tsx/css      # Modal listing pending AI edit marks per file
│   │   │   ├── Sidebar.tsx/css            # Left file-tree explorer; AI mark count badge; context menus
│   │   │   ├── TabBar.tsx/css             # Open-file tabs (⌘W to close, ⌃Tab to switch)
│   │   │   ├── FindReplaceBar.tsx/css     # In-editor find/replace (⌘F)
│   │   │   ├── ProjectSearchPanel.tsx/css # Workspace-wide text search + replace
│   │   │   ├── MarkdownPreview.tsx/css    # Rendered MD viewer (marked)
│   │   │   ├── PDFViewer.tsx/css          # Native PDF embed via Tauri asset://
│   │   │   ├── MediaViewer.tsx/css        # Image/video viewer — binary Tauri fs read
│   │   │   ├── ImageSearchPanel.tsx/css   # Pexels stock photo search → workspace/images/
│   │   │   ├── SettingsModal.tsx/css      # App settings + keyboard shortcuts table
│   │   │   ├── SyncModal.tsx/css          # Git commit + push modal
│   │   │   ├── GooglePanel.tsx/css        # Google Drive + Slides (button hidden, code kept)
│   │   │   ├── WorkspacePicker.tsx/css    # First-run workspace selection screen
│   │   │   ├── WorkspaceHome.tsx/css      # Dashboard shown when no file is open
│   │   │   └── UpdateModal.tsx/css        # In-app update progress modal
│   │   ├── services/
│   │   │   ├── copilot.ts    # streamCopilotChat(), runCopilotAgent(), fetchCopilotModels(),
│   │   │   │                 #   modelSupportsVision(), startDeviceFlow(), getStoredOAuthToken()
│   │   │   ├── aiMarks.ts    # loadMarks(), addMark(), markReviewed() — .customtool/ai-marks.json
│   │   │   ├── copilotLog.ts # appendLogEntry() — session log in .customtool/copilot-log.jsonl
│   │   │   ├── google.ts     # OAuth PKCE, Drive backup/restore, Slides generation (dormant)
│   │   │   └── workspace.ts  # loadWorkspace(), readFile(), writeFile(), buildFileTree(), createCanvasFile()
│   │   ├── types/
│   │   │   └── index.ts      # All shared TS interfaces: CopilotModelInfo (supportsVision), AIEditMark, etc.
│   │   ├── utils/
│   │   │   ├── canvasAI.ts       # summarizeCanvas() (hierarchical), canvasToDataUrl(), executeCanvasCommands()
│   │   │   ├── workspaceTools.ts # WORKSPACE_TOOLS (OpenAI format) + buildToolExecutor() for agent
│   │   │   └── fileType.ts       # getFileTypeInfo() — maps extension → kind/mode/language
│   │   ├── App.tsx           # Root: tabs + sidebar + editor/viewer + AI panel + all modals
│   │   └── App.css
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── lib.rs        # Tauri commands: git_init, git_sync, update_app + native menu
│   │   │   └── main.rs
│   │   ├── capabilities/default.json  # FS + HTTP permissions — $HOME/**, pexels + images.pexels.com
│   │   └── tauri.conf.json
│   ├── .env                  # VITE_GITHUB_TOKEN=... (gitignored, optional — OAuth preferred)
│   └── .env.example
├── docs/
│   └── brainstorm.md
├── scripts/
│   ├── build-mac.sh          # Full Tauri build + install to ~/Applications (~5-8 min first time)
│   ├── update-app.sh         # Incremental rebuild + reinstall (~15-120s)
│   └── sync.sh               # git add -A + commit + push
├── AGENT.md                  # ← you are here
└── README.md
```

---

## Key Data Flows

### File open
1. User clicks file in Sidebar → `onFileSelect(relPath)` → `handleOpenFile()` in App
2. `getFileTypeInfo(filename)` decides kind (`markdown | pdf | code | canvas | unknown`) and default `viewMode`
3. PDF: sets `activeFile`, skips text read → renders `<PDFViewer absPath=...>`
4. Canvas (`.tldr.json`): reads file → `content` = raw JSON → renders `<CanvasEditor key={activeFile}>` (keyed to force remount on file switch)
5. MD/code: `readFile(workspace, filename)` → sets `content` state → renders `<Editor>` or `<MarkdownPreview>`

### Auto-save
- `handleContentChange` debounces 1 s → `writeFile(workspace, activeFile, content)`

### AI chat
- ⌘K opens AIPanel
- **Agent mode** (workspace open): `runCopilotAgent()` — tool-calling loop, MAX_ROUNDS=50; exhaustion shows user-facing "continue" prompt
- **Plain chat** (no workspace): `streamCopilotChat()` — single-turn streaming
- System prompt `content` is a **single joined string** — never an array (arrays cause 400 on Claude/o-series)
- `agentContext` = AGENT.md contents (first 3000 chars injected into system prompt)
- `documentContext` = current doc excerpt (first 6000 chars)
- **Vision:** on every send, if a canvas is open and model supports vision, the canvas screenshot is merged into the user message as multipart `[image_url, text]` — avoids consecutive-user-messages 400
- `modelSupportsVision(id)` — false for `/^o\d/` (o1, o3, o3-mini, o4-mini)
- Error messages: API JSON body parsed for `error.message` before surfacing to UI
- Models fetched once on first open; `modelsLoadedRef` prevents double-fetch

### Context management (anti-overflow)
The agent tracks estimated token usage on every round (rough proxy: `JSON.chars / 4`).

**Token-triggered summarization** (`CONTEXT_TOKEN_LIMIT = 90_000`):
1. When `estimateTokens(loop) > 90_000`, the agent calls the model (non-streaming) with a summarization prompt asking for a dense technical briefing (400–700 words).
2. The full conversation snapshot (base64 images stripped) is written to `<workspace>/customtool/copilot-log.jsonl` as an `archive` entry.
3. The context window is rebuilt to a compact form: system messages → original user task → synthetic `[SESSION SUMMARY]` user message → last 8 messages verbatim.
4. A brief inline notice is streamed to the user: `_[Context approaching limit — summarizing prior session and continuing...]_`

**Lightweight fallback** (active only when under the token limit): keeps last 14 assistant+tool round groups and deduplicates stale vision messages.

### Copilot log file format
All agent activity is persisted to `<workspace>/customtool/copilot-log.jsonl` — one JSON object per line.

Two entry types coexist in the same file:

| Field | Exchange entry | Archive entry |
|---|---|---|
| `entryType` | (absent) | `"archive"` |
| `sessionId` | ✓ | ✓ |
| `timestamp` / `archivedAt` | ✓ | ✓ |
| `userMessage` / `aiResponse` | ✓ | — |
| `toolCalls?` | ✓ | — |
| `summary` | — | ✓ — model-generated dense summary |
| `messages` | — | ✓ — full turn-by-turn transcript (base64 stripped) |
| `estimatedTokens` | — | ✓ |
| `round` | — | ✓ |

**As the in-app agent, you can read this file:**
```
read_file({ path: "<workspacePath>/customtool/copilot-log.jsonl" })
```
Parse each line as JSON. Look for `entryType === "archive"` entries to reconstruct earlier session context. The `summary` field gives a concise overview; `messages` gives the full transcript.

### Workspace load
- `loadWorkspace(path)` → reads config, AGENT.md, runs `git_init`, builds `fileTree` (recursive, depth≤8), lists `.md` files
- Config stored in `<workspace>/.customtool/config.json`
- Recent workspaces persisted to `localStorage`

### In-app update
- Header or ⌘⇧U → `update_app` Rust command → streams build output via `update:log` events → copies `.app` → `open` + `exit(0)`

---

## Workspace / Sidebar Behaviour

- File tree is **fully recursive**, skipping: `node_modules`, `.git`, `.customtool`, `target`, `.DS_Store`, dotfiles
- Depth limit: 8 levels
- Directories sort before files; both alphabetical within group
- Root-level directories auto-expanded on load
- `Workspace.files` (flat `.md` list) is kept for backwards-compat with config (`lastOpenedFile`)

### Creating files and folders

There are three ways to create a new file or folder:
1. **EXPLORER header hover** — hover the EXPLORER label to reveal `+` (file) and `⊞` (folder) buttons at workspace root
2. **Directory row hover** — hover any folder in the tree to reveal a `+` icon; triggers creation inside that folder
3. **Right-click context menu** — right-click any file or folder → "New file here" / "New folder here"

All three open the same **inline creator panel** in the sidebar footer:
- Shows context label: `+ file in docs/` or `⊞ folder at root`
- **Type pills** for text/code formats: MD · TS · TSX · JS · JSON · CSS · HTML · PY · SH · TXT
- **`◈ Canvas`** button below the pills — visually distinct (gold), creates a `.tldr.json` canvas file
- Name input auto-focuses; Enter confirms, Esc cancels
- Auto-expands the target directory and opens the newly created file

`workspace.ts` helpers:
- `createFile(workspace, relPath)` — extension-aware, creates parent dirs as needed
- `createCanvasFile(workspace, relPath)` — writes empty `.tldr.json`, creates parent dirs
- `createFolder(workspace, relPath)` — `mkdir -p` equivalent

---

## Editor / Viewer Modes

| File type | Mode | Toggle shown | Notes |
|---|---|---|---|
| `.md` / `.mdx` | Edit (default) | Yes — Edit / Preview | Preview uses `marked` (GFM) |
| `.pdf` | Preview only | No | `convertFileSrc` → WebKit embed |
| `.tldr.json` | Canvas only | No | tldraw v4; JSON snapshot stored on disk; git-tracked; grid+snap on by default; **Frames = slides** |
| `.ts`, `.js`, code | Edit only | No | CodeMirror, no syntax HL yet (extension not loaded) |
| unknown | Edit only | No | Plain text fallback |

---

## AI Model Picker

- Dropdown in AIPanel header shows live models from `/models`
- Rate badges: **free** (green, 0×), **standard** (blue, 1×), **premium** (yellow, >1×)
- `isPremium` = `multiplier > 1`
- `supportsVision: boolean` on `CopilotModelInfo` — false for o-series reasoning models
- `FALLBACK_MODELS`: gpt-4o-mini (free, vision ✓), gpt-4o (1×, vision ✓), claude-sonnet-4-5 (1×, vision ✓), o3-mini (1×, vision ✗)

---

## Canvas Editor Details

- **Persistence:** `editor.getSnapshot()` → debounced 500ms → JSON saved to `.tldr.json`
- **Frames = Slides:** 1280×720px, arranged horizontally with 80px gaps (`SLIDE_W`, `SLIDE_H`, `SLIDE_GAP`)
- **Slide strip (bottom bar):**
  - Cards are draggable — reorder by swapping x-positions via `editor.updateShape()`
  - Right-click context menu: Export PNG / Move Left / Move Right / Duplicate / Delete
  - Format panel shows "Slide / ↓ Export PNG" when a frame is selected
- **Present mode:** `▶ Present` → locks to slide 0; ←/→/Space navigates; Esc exits
- **AI canvas tools:**
  - `list_canvas_shapes` — must be called before modifying existing shapes (provides IDs)
  - `canvas_op` — `{"op":"clear"}` marked DANGER in both system prompt and tool description
  - `canvas_screenshot` — returns `__CANVAS_PNG__:base64` sentinel; agent loop injects it as vision message
  - `summarizeCanvas()` — hierarchical: slides list their children by `parentId`
  - `executeCanvasCommands()` returns `{ count, shapeIds }` (destructure, not a plain number)
- **tldraw chrome removed:** SharePanel, HelpMenu, Minimap
- **Grid/snap:** `updateInstanceState({ isGridMode: true })` on mount

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| ⌘K | Toggle AI panel |
| ⌘B | Toggle sidebar |
| ⌘W | Close active tab |
| ⌘, | Open Settings |
| ⌘⇧R | Reload active file from disk |
| ⌃Tab | Next tab |
| ⌃⇧Tab | Previous tab |
| ⌘F | Find/replace in editor |
| ⌘⇧U | In-app update |

---

## Known Limitations / Next Up

- **No syntax highlighting** for non-Markdown files (CodeMirror language extensions not loaded)
- **`git_sync`** — best-effort push to `origin HEAD`; no remote = silently OK
- **Google Drive / Slides:** Fully implemented in `google.ts` + `GooglePanel.tsx`; sidebar button commented out — re-enable by uncommenting in `Sidebar.tsx`
- **Image save (Pexels):** Requires Tauri app rebuild after `capabilities/default.json` change (`images.pexels.com` domain added); run `./scripts/update-app.sh`
- **AI mark jump on canvas:** Zooms to shape bounds; text-file jump uses `editorRef.jumpToText()`

---

## Dev Commands

```bash
# Run in dev mode
cd app && npm run tauri dev

# Full build + install to ~/Applications
./scripts/build-mac.sh --install

# Quick rebuild + reinstall (incremental)
./scripts/update-app.sh

# Type-check only
cd app && npx tsc --noEmit
```

---

## Session Notes

- **2026-02-22 (init)** — Project initialized. Repo created on GitHub. Core infrastructure (git, scripts, AGENT.md) in place.
- **2026-02-22 (brainstorm)** — Full capability & stack brainstorm. See `docs/brainstorm.md`.
- **2026-02-22 (decision)** — Stack decided: Tauri v2 + React/TypeScript. No backend. GitHub Copilot API as primary AI. Google Slides for presentations. Mobile = view + voice only.
- **2026-02-22 (phase1-scaffold)** — Phase 1 MVP scaffolded: Tauri v2 app in `app/`, CodeMirror 6 Markdown editor, GitHub Copilot API streaming integration, AI panel (⌘K), `.env` setup. Tauri FS plugin wired for open/save. WorkspacePicker, Sidebar, UpdateModal added.
- **2026-02-22 (file-tree)** — Sidebar replaced with recursive VS Code-style file tree. `buildFileTree()` added to workspace service. `FileTreeNode` type added. Root dirs auto-expand. File-type icons per extension. `Workspace.fileTree` added alongside `Workspace.files`.
- **2026-02-22 (model-picker)** — AI model picker overhauled. `fetchCopilotModels()` fetches live list from Copilot `/models`. Custom dropdown with tiered rate badges (free/standard/premium). `CopilotModelInfo` type + `FALLBACK_MODELS` added.
- **2026-02-22 (edit-preview)** — Edit/Preview toggle added to header. `getFileTypeInfo()` utility maps extension → kind/mode. `MarkdownPreview` (marked) and `PDFViewer` (Tauri asset://) components added. PDFs open directly in preview; MD defaults to edit.
- **2026-02-22 (code-review)** — Fixed 5 bugs: duplicate step comment in workspace.ts; stale Copilot API version headers in streamCopilotChat (was 1.85/0.11, now 1.97/0.24); `isPremium` inconsistency in FALLBACK_MODELS; dead `handleFilesChange`/`onFilesChange` prop removed; fragile `availableModels !== FALLBACK_MODELS` reference check replaced with `modelsLoadedRef`. AGENT.md fully rewritten.
- **2026-02-22 (grammarly-model-sync)** — Three Phase 1 gaps closed: (1) `@grammarly/editor-sdk` installed and wired into `Editor.tsx` (later removed — Grammarly desktop app hooks natively). (2) `WorkspaceConfig.preferredModel` now fully wired — AIPanel accepts `initialModel`/`onModelChange` props; App.tsx calls `saveWorkspaceConfig` on every model switch. (3) Git Sync button added to Sidebar footer — calls `invoke('git_sync')` with a timestamp commit message; shows idle/syncing/done/error states with colour feedback.
- **2026-02-22 (google-phase2)** — Phase 2 Google integration implemented: `google_oauth` Rust command (PKCE + local TCP redirect server + browser open via `tauri-plugin-opener`); `services/google.ts` (OAuth2 PKCE token exchange/refresh, Drive backup folder + upload/download, Slides generation from `## heading` outline via batchUpdate API); `GooglePanel.tsx` modal — connect/disconnect, Drive file list + restore, Slides generate + iframe embed preview. Sidebar `⊡ Google` button. Cargo adds `sha2`, `base64`, `rand`. `.env.example` updated with Desktop app OAuth setup steps.
- **2026-02-22 (tldraw-canvas)** — tldraw v4.4.0 canvas integrated. `CanvasEditor.tsx` wraps `<Tldraw>` with file-based persistence: snapshot serialised to JSON via `editor.getSnapshot()`, debounced 500 ms, saved to `.tldr.json` via existing auto-save path. `FileKind` extended with `'canvas'`; `.tldr.json` detected before generic JSON in `getFileTypeInfo()`. `createCanvasFile()` added to workspace service. Sidebar `+ New canvas` button added; `⊡ Google` button commented out (code kept). App.tsx wires canvas branch into render cascade; word count hidden for canvas files.
- **2026-02-22 (sidebar-creator)** — Sidebar file/folder creation overhauled. Three trigger points: EXPLORER header hover icons, directory row hover `+`, right-click context menu. Unified inline creator panel with type pills (MD/TS/TSX/JS/JSON/CSS/HTML/PY/SH/TXT) and a distinct `◈ Canvas` toggle button (creates `.tldr.json`). Canvas is visually separated from code/text types (gold colour, full-width button). `createFolder()` added to `workspace.ts`. All creation now supports nested paths + auto-creates missing parent dirs.
- **2026-02-22 (canvas-present)** — Canvas upgraded: tldraw Frames now act as slides. `▶ Present` button appears as a floating overlay; clicking it locks camera to frame 0 and hides tldraw share/help/minimap chrome. Keyboard: ←/→/Space navigates slides, Esc exits. Grid mode (`isGridMode: true`) enabled on mount for snap-to-grid design. `inferDarkMode` wired so tldraw matches app theme. `TLComponents` override defined as stable module constant.
- **2026-02-22 (canvas-figma)** — Canvas upgraded toward Figma/Miro/Slides UX. (1) **Slide strip**: horizontal scrollable panel at bottom of canvas (like Google Slides filmstrip / Figma pages panel). Shows all `frame` shapes as numbered cards. Click = zoom to. Double-click = present from that slide. `▼ Slides` toggle collapses/expands. Active slide highlighted in blue during presentation. (2) **`+ Slide` button**: creates a 1280×720 frame positioned to the right of the last one with a 80px gap; zooms camera to new slide. (3) **Export PNG**: `↓` button on each card calls `exportAs(editor, [frameId], { format: 'png', name })`. (4) **Figma-like zoom**: `cameraOptions={{ wheelBehavior: 'zoom' }}` — scroll wheel / trackpad now zooms instead of panning (same as Figma). (5) **Reactive frame sync**: `store.listen(syncFrames, { scope: 'document' })` keeps strip up-to-date as shapes change. `canvas-editor-main` wrapper added (flex:1) so strip has a fixed area below canvas. Layout is stable at any strip state.
- **2026-02-23 (canvas-ai-hardening)** — AI canvas reliability pass: (1) `MAX_ROUNDS` 6→50; exhaustion shows user-visible "continue" CTA. (2) `{"op":"clear"}` guarded — removed from normal op list in system prompt + marked DANGER in tool description. (3) `summarizeCanvas()` made hierarchical — builds `frameChildren` map, lists each slide's children under it. (4) `modelSupportsVision(id)` helper + `supportsVision` field on `CopilotModelInfo` — o-series models get no image inputs. (5) Before-screenshot injected as multipart user message on every canvas send (not a separate user message — avoids consecutive-user-messages 400). (6) Better API error messages: JSON `error.message` extracted before surfacing.
- **2026-02-23 (slide-strip-ux)** — Slide strip UX overhaul: drag-to-reorder (x-position swap), right-click context menu (Export PNG / Move Left / Move Right / Duplicate / Delete), format panel "Slide / ↓ Export PNG" section when frame selected, reduced card width 180→120px. Fixed `TLFrameShape` (not exported by tldraw v4 — use `AnyFrame` cast), `editor.batch()` (doesn't exist — use plain loop), `executeCanvasCommands` return type (destructure `{ count }`).
- **2026-02-23 (image-save-fix)** — Pexels image save button was silently doing nothing: root cause was native `fetch()` being blocked by Tauri HTTP allow-list (only `api.pexels.com` was listed, not `images.pexels.com`). Fixed: switched to `tauriFetch`, added `images.pexels.com/**` to `capabilities/default.json`.
- **2026-02-23 (ai-review-panel)** — `AIReviewPanel` was built but never mounted. Wired up: import + `showAIReview` state in App.tsx; both `onOpenAIReview` callbacks (Sidebar + WorkspaceHome) now open the panel; `onJumpToText` closes panel and jumps editor to passage.
- **2026-02-23 (context-summarization)** — Mid-run context summarization added to `runCopilotAgent`: `estimateTokens()` tracks approximate token usage per round (chars/4); when over `CONTEXT_TOKEN_LIMIT=90_000` the agent calls the model for a dense session summary, writes a full conversation snapshot (sans base64) to `customtool/copilot-log.jsonl` as a new `archive` entry type, then rebuilds the context window to: system msgs + original task + `[SESSION SUMMARY]` + last 8 messages. Fallback blind round-pruning retained for sub-limit overage. `runCopilotAgent` now accepts `workspacePath?` and `sessionId?` params, threaded from AIPanel. `copilotLog.ts` extended with `CopilotArchiveEntry` interface + `appendArchiveEntry()`. AGENT.md updated with log format docs.
- **2026-02-23 (canvas-slide-sync)** — Slide strip ordering and theme system hardened. (1) Frame sort uses `.sort((a, b) => a.x - b.x)` in `syncFrames`, `addSlide`, `rescanFrames`, `enterPresent` — fixes reorder inconsistencies. (2) Camera-based active frame tracking in `handleMount` (store listener on viewport change). (3) `applyThemeToSlides()` extended to restyle shapes tagged `meta.textRole` (heading/body) — changes font/color/size when theme switches. (4) `insertTextPreset(variant)` creates a properly-themed text shape inside the current slide and immediately enters edit mode — replaces the old pen-style-only buttons. (5) Strip active highlight works outside presentation mode too.
- **2026-02-23 (canvas-theme-bg)** — Theme image background loading fixed end-to-end. Root causes: (a) `convertFileSrc` produces `asset://localhost/…` URLs which required `assetProtocol` plugin — now enabled in `tauri.conf.json` with `scope: ["$HOME/**"]`. (b) `asset://` paths don't persist across restarts. Fix: theme image picker reads the chosen file via `readFile` (imported from `@tauri-apps/plugin-fs`), converts to base64 data URL via `FileReader`, stores the self-contained data URL in `slideBgImage`. Active image label shows "Custom image" for data URLs instead of a garbage path.
- **2026-02-23 (canvas-slide-layouts)** — Slide layout system added to `CanvasEditor`. `applySlideLayout(editor, frame, layoutId, theme)` provides 6 presets: `blank`, `title-only`, `title-body`, `title-subtitle`, `two-column`, `image-right`. Shapes created by layouts are tagged `meta.textRole` so theme changes auto-restyle them. `CanvasTheme` interface gains `defaultLayout?: string`. Theme panel gains a 3×2 grid of layout buttons + Apply to Slide. New slides created via `addSlide` auto-populate using `defaultLayout` (default: `title-body`).
- **2026-02-23 (canvas-format-panel-v1)** — Format panel (`CanvasFormatPanel` in `CanvasEditor.tsx`) extended with professional tools: (1) Rotation — ±15° step buttons + direct number input. (2) Opacity — 0–100 slider. (3) Align & Distribute — 6 alignment operations (left/center/right/top/middle/bottom) for multi-select; 2 distribute ops (H/V). (4) Lock/Unlock — locks shapes and deselects them. (5) Corner radius — 0–50 slider, applied via `shape.meta.cornerRadius`, rendered in tldraw `shapeIndicators` override. (6) Shadow — `ShadowMeta` stored in `shape.meta.shadow`; 4 presets (none/soft/medium/hard) + individual sliders for blur/x/y/opacity; rendered via CSS drop-filter + custom SVG overlay on shape.
- **2026-02-23 (canvas-format-panel-v2)** — Five more format panel controls added matching Figma/Miro parity: (1) **Geo shape type picker** — `geoInfo` useValue detects when all selected shapes are non-bg geo; shows 10 common types in a 5-column grid (rect/ellipse/triangle/diamond/hex/star/cloud/heart/check-box/x-box) + expandable extra row of 10 (pentagon/octagon/arrows/rhombus variants); uses `(shape.props as any).geo` since `GeoShapeGeoStyle` is not exported from tldraw. (2) **W×H dimension inputs** — `sizeInfo` useValue for single geo/image shape; two number inputs for exact pixel dimensions. (3) **Layer order** — `canReorder` useValue; 4 buttons: ⤒ `.bringToFront()`, ↑ `.bringForward()`, ↓ `.sendBackward()`, ⤓ `.sendToBack()`. (4) **Group/Ungroup** — `canGroup` (2+ non-frame), `isGroup` (single group) useValues; `editor.groupShapes()` / `editor.ungroupShapes()`. (5) **Flip H/V** — `canFlip` useValue for geo/image shapes; `editor.flipShapes(ids, 'horizontal'|'vertical')`.
- **2026-02-23 (ai-error-recovery)** — `onError` callback in `handleSend` (AIPanel.tsx) now preserves already-streamed partial text on error. Previously it called `setLiveItems([])` immediately, silently discarding anything the model had already streamed. Fix: before clearing, commits the partial as a regular assistant message (same pattern as `handleStop` and the interrupt flow), then shows the error banner below it. No-op if nothing was streamed yet.
