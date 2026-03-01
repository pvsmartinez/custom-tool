# GitHub Copilot — VS Code Instructions

> **Role:** You are the coding assistant for **cafezin** — a Tauri v2 + React/TypeScript desktop app. Your job is to build, maintain, and debug the codebase. Read AGENT.md for full project context.

---

## Stack at a Glance

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 (Rust) |
| Frontend | React 19, TypeScript, Vite |
| Editor | CodeMirror 6 (`@uiw/react-codemirror`) |
| Canvas | **tldraw v4** — `.tldr.json` files |
| AI backend | GitHub Copilot API (OpenAI-compatible, SSE streaming) |
| Auth | Device-flow OAuth (`copilot.ts`) |
| File I/O | `@tauri-apps/plugin-fs` — **always use `readFile`/`writeFile` from this plugin, never native `fetch` or `XMLHttpRequest` for local files** |
| HTTP (external) | `@tauri-apps/plugin-http` `fetch` (alias: `tauriFetch`) — required for any outbound request |
| PDF | `convertFileSrc` + WebKit `<embed>` |
| Voice | MediaRecorder → Groq Whisper via Tauri `transcribe_audio` command |

---

## Critical Rules

### Never break TypeScript — zero errors is the bar
Run `cd app && npx tsc --noEmit` after every non-trivial change. The only acceptable pre-existing warning is the `historyIdx` unused variable in `BottomPanel.tsx`.

### tldraw API (v4) — key gotchas
- `TLFrameShape` is **not exported** — cast as `AnyFrame = TLShape & { x:number; y:number; props: { w:number; h:number; name:string } }`.
- `editor.batch()` does **not exist** — use a plain `for` loop for multi-shape updates.
- `GeoShapeGeoStyle` is **not exported** — read/write geo type via `(shape.props as any).geo`.
- `editor.groupShapes(ids, { select: true })` / `editor.ungroupShapes(ids, { select: true })`.
- `editor.flipShapes(ids, 'horizontal' | 'vertical')`.
- `editor.bringToFront(ids)` / `editor.bringForward(ids)` / `editor.sendBackward(ids)` / `editor.sendToBack(ids)`.
- `executeCanvasCommands()` returns `{ count, shapeIds }` — destructure, not a plain number.
- Slides = Frames, 1280×720px, sorted by `.x` position (not creation order).

### Copilot API
- System prompt `content` must be a **single joined string**, never an array — arrays cause 400 errors on Claude/o-series.
- Vision: o-series models (`/^o\d/`) don't accept image inputs — gate with `modelSupportsVision(id)`.
- Canvas screenshot is merged into the user message as multipart `[image_url, text]` — do **not** add a separate user message or you'll get a consecutive-user-messages 400.

### Asset URLs in Tauri
- `asset://` URLs (from `convertFileSrc`) require `assetProtocol` enabled in `tauri.conf.json`.
- For user-chosen images stored in app state: convert to **base64 data URL** via `readFile` + `FileReader` so they're self-contained and survive restarts.

### Streaming / error handling
- `onError` in `handleSend` must preserve already-streamed partial text by committing it as an assistant message before showing the error banner — see `AIPanel.tsx` `onError` callback for the canonical pattern.

---

## File Map & Architecture

> Full file map, data flows, canvas details, agent loop, keyboard shortcuts, and session history
> are documented in **AGENT.md** at the project root. Read that file for deep context.

**Key files at a glance:**
- `app/src/components/CanvasEditor.tsx` — tldraw v4 canvas (slides, strip, format panel)
- `app/src/components/AIPanel.tsx` — Copilot chat, agent loop, voice, model picker
- `app/src/services/copilot.ts` — `streamCopilotChat`, `runCopilotAgent`, `fetchCopilotModels`
- `app/src/utils/workspaceTools.ts` — `WORKSPACE_TOOLS` + `buildToolExecutor`
- `app/src/utils/canvasAI.ts` — `summarizeCanvas`, `canvasToDataUrl`, `executeCanvasCommands`

**Format Panel (`CanvasFormatPanel`)** — do not re-add already-implemented controls.
Currently implemented: font, size, text align, color, fill, stroke/dash, rotation, opacity,
align/distribute, lock, corner radius, shadow, geo type picker, W×H inputs, layer order,
group/ungroup, flip H/V, slide export. See AGENT.md for the full list.

**Agent loop** — `MAX_ROUNDS=50`, `CONTEXT_TOKEN_LIMIT=90_000`, auto-summarization on overflow.
Available tools: `read_workspace_file`, `write_workspace_file`, `list_workspace_files`,
`list_canvas_shapes`, `canvas_op`, `canvas_screenshot`, `mark_for_review`.

---

## Dev Workflow

```bash
# Dev server (hot reload)
cd app && npm run tauri dev

# Type-check (must be zero errors)
cd app && npx tsc --noEmit

# Quick rebuild + reinstall to ~/Applications/Cafezin.app
./scripts/update-app.sh

# Full production build
./scripts/build-mac.sh --install
```

---

## In-App AI Agent Capabilities

The **in-app Copilot** (AIPanel) can:
- Read and write any file in the open workspace via `read_workspace_file` / `write_workspace_file`
- List files via `list_workspace_files`
- Read canvas shape IDs via `list_canvas_shapes` (required before modifying an existing canvas)
- Execute canvas mutations via `canvas_op` (add/move/update/delete shapes; `{"op":"clear"}` is destructive — guarded)
- Capture canvas screenshot via `canvas_screenshot` (returns base64 PNG, auto-injected as vision message)
- Mark text passages for human review via `mark_for_review`

The in-app agent **cannot**:
- Execute shell commands or arbitrary code
- Access files outside the open workspace
- Generate or display images (text + canvas shapes only)
- Make network requests beyond the Copilot API itself
