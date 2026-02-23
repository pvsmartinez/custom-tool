# AGENT.md — Project Context for AI Sessions

## Project: custom-tool

**Owner:** Pedro Martinez (pvsmartinez@gmail.com)  
**Repo:** https://github.com/pvsmartinez/custom-tool  
**Started:** February 2026

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
- **AI:** GitHub Copilot API (`https://api.githubcopilot.com`) — OpenAI-compatible, streamed via SSE
  - Token: `VITE_GITHUB_TOKEN` in `app/.env` (GitHub PAT with `copilot` scope)
  - Models fetched dynamically from `/models` endpoint; `FALLBACK_MODELS` used if that fails
- **Documents:** Markdown + YAML frontmatter (git-friendly, exportable)
- **Version control:** git per workspace, auto-init via Rust `git_init` command
- **In-app update:** `update_app` Rust command — runs `npm run tauri build`, copies `.app` to `~/Applications`, relaunches
- **Voice:** Web Speech API — `webkitSpeechRecognition` in AIPanel (hold mic button)
- **Preview:** `marked` library renders MD → HTML in `MarkdownPreview` component
- **PDF:** Tauri `convertFileSrc` + native WebKit `<embed type="application/pdf">`
- **No backend server** — all data stays local; API calls go directly from WebView

---

## Project Structure

```
custom-tool/
├── app/                          # Tauri v2 app root
│   ├── src/
│   │   ├── components/
│   │   │   ├── Editor.tsx/css          # CodeMirror 6 Markdown editor
│   │   │   ├── CanvasEditor.tsx/css    # tldraw v4 canvas — .tldr.json files
│   │   │   ├── AIPanel.tsx/css         # Right-side Copilot chat panel (⌘K)
│   │   │   ├── Sidebar.tsx/css         # Left file-tree explorer (VS Code style)
│   │   │   ├── MarkdownPreview.tsx/css # Rendered MD viewer (marked)
│   │   │   ├── PDFViewer.tsx/css       # Native PDF embed via Tauri asset://
│   │   │   ├── GooglePanel.tsx/css     # Google Drive + Slides (button hidden, code kept)
│   │   │   ├── WorkspacePicker.tsx/css # First-run workspace selection screen
│   │   │   └── UpdateModal.tsx/css     # In-app update progress modal
│   │   ├── services/
│   │   │   ├── copilot.ts    # streamCopilotChat(), fetchCopilotModels(), copilotComplete()
│   │   │   ├── google.ts     # OAuth PKCE, Drive backup/restore, Slides generation (dormant)
│   │   │   └── workspace.ts  # loadWorkspace(), readFile(), writeFile(), buildFileTree(), createCanvasFile()
│   │   ├── types/
│   │   │   └── index.ts      # All shared TypeScript interfaces
│   │   ├── utils/
│   │   │   └── fileType.ts   # getFileTypeInfo() — maps extension → kind/mode/language
│   │   ├── App.tsx           # Root: header + sidebar + editor/viewer + AI panel
│   │   └── App.css
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── lib.rs        # Tauri commands: git_init, git_sync, update_app + native menu
│   │   │   └── main.rs
│   │   ├── capabilities/default.json  # FS permissions ($HOME/**)
│   │   └── tauri.conf.json
│   ├── .env                  # VITE_GITHUB_TOKEN=... (gitignored)
│   └── .env.example
├── docs/
│   └── brainstorm.md         # Capability & stack brainstorm
├── scripts/
│   ├── build-mac.sh          # Full Tauri build + install to ~/Applications
│   ├── update-app.sh         # Quick rebuild + reinstall
│   └── sync.sh               # git add -A + commit + push
├── AGENT.md
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
- ⌘K opens AIPanel → `streamCopilotChat(messages, onChunk, onDone, onError, model)`
- System prompt includes `agentContext` (AGENT.md contents) and excerpt of current document
- Models fetched once on first open from `/models`; `modelsLoadedRef` prevents double-fetch

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
- `isPremium` = `multiplier > 1` (consistent in both fetch logic and `FALLBACK_MODELS`)
- `FALLBACK_MODELS`: gpt-4o-mini (0×), gpt-4o (1×), claude-sonnet-4-5 (1×), gemini-2.0-flash (2×)

---

## Known Limitations / Next Up

- **No syntax highlighting** for non-Markdown files in the editor (CodeMirror language extensions not loaded for code files yet)
- **`git_sync` UI** — Sync button is now in the Sidebar footer. Auto-push to `origin HEAD` is best-effort (no remote = silently OK).
- **`WorkspaceConfig.preferredModel`** — now saved & restored per workspace; wired to the model picker in AIPanel.
- **Grammarly:** The Grammarly desktop app hooks directly into CodeMirror's `contenteditable` via the macOS accessibility/input layer — no SDK needed. `@grammarly/editor-sdk` was removed.
- **PDF files in Tauri:** Requires `fs:allow-read-file` permission scoped to `$HOME/**` (already set). No write support intended.- **Google Drive / Slides button hidden:** Code fully implemented; `⊡ Google` Sidebar button commented out. Re-enable by uncommenting in `Sidebar.tsx`.
- **tldraw canvas:** `CanvasEditor` persists via `editor.getSnapshot()` → JSON stored in `.tldr.json`. No IndexedDB (`persistenceKey` not used). AI can read/write the snapshot JSON directly. **Grid/snap** enabled on mount via `updateInstanceState({ isGridMode: true })`. **Dark mode** inferred from system. **Frames are slides** — `▶ Present` button zooms through frames in order; ←/→/Space navigate, Esc exits. `SharePanel`, `HelpMenu`, and `Minimap` removed from tldraw UI chrome.
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
