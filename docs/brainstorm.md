# Brainstorm — custom-tool

> Session: 2026-02-22  
> Purpose: Explore capabilities, platform options, and tech stack before committing to an architecture.

---

## 1. Core Capabilities Wanted

| Capability | Notes |
|---|---|
| Long-form writing (books, articles) | MD-native, export to PDF / DOCX |
| Course & class creation | Structured content, possibly slides |
| Grammarly integration | Grammar/style checking inline |
| AI assistance with model swapping | Copilot, GPT-4o, Claude, Gemini — interchangeable |
| Slideshow / presentation support | Google Slides API is an option |
| Git version history under the hood | Every project auto-tracked in git |
| AI vs. Human content tracking | Know what was AI-generated vs. human-reviewed |
| MCP bridges to external tools | Connect AI to Google Docs, Slides, filesystem, git |
| Cross-platform | macOS (primary), PC, Web, iPhone, Android |

---

## 2. Platform / Framework Options

### Option A — Tauri v2 (Recommended)
- **What:** Rust backend + any web frontend (React / Vue / Svelte)
- **Platforms:** macOS, Windows, Linux, iOS (beta), Android (beta), Web (progressive)
- **Pros:**
  - Much lighter than Electron (~5–10 MB vs ~150 MB)
  - Single codebase for all platforms
  - Native OS APIs via Rust (filesystem, git via `git2` crate, keychain)
  - Massive TypeScript/React ecosystem — AI tools handle it very well
  - Grammarly Text Editor SDK works in the WebView
  - MCP client libraries available in TypeScript
  - Very active, well-funded (v2 stable since late 2024)
- **Cons:**
  - Mobile support (iOS/Android) is beta — functional but not polished yet
  - Rust learning curve for backend features

### Option B — Electron
- **What:** Node.js backend + any web frontend
- **Platforms:** macOS, Windows, Linux (web via separate deploy)
- **Pros:**
  - Most mature, largest ecosystem
  - VS Code itself is Electron — huge community knowledge
  - Grammarly SDK, all JS libraries work natively
- **Cons:**
  - Very heavy (~150 MB baseline)
  - No mobile support
  - Higher memory usage

### Option C — Flutter
- **What:** Dart language, single codebase UI
- **Platforms:** macOS, Windows, Linux, iOS, Android, Web
- **Pros:**
  - Best native mobile experience of the cross-platform options
  - True single codebase including mobile
  - Great for polished, consistent UI across all platforms
- **Cons:**
  - Dart — smaller AI training data, less IDE support
  - Web story is weaker than native web frameworks
  - Fewer integrations for Grammarly, MCP clients, AI SDKs
  - Less mature desktop support than mobile

### Option D — VS Code Extension only
- **What:** Build as a VS Code extension using the Chat Participant API
- **Platforms:** Wherever VS Code runs
- **Pros:**
  - Deepest Copilot integration possible — `request.model` gives you whatever model the user has selected
  - Model swapping is built-in (user picks in the chat dropdown)
  - Full access to Copilot's Language Model API
  - Already familiar to Pedro
  - Zero distribution friction (publish to Marketplace)
  - Can register MCP servers directly, call tools, stream responses
- **Cons:**
  - Requires VS Code — not a standalone consumer app
  - Limited UI compared to a custom app
  - Not ideal for non-technical end users

### Option E — Native Swift / SwiftUI + separate web app
- **What:** Best-in-class macOS native app, separate React web app
- **Pros:**
  - Premium macOS experience
  - Native iCloud, Keychain, Spotlight integration
- **Cons:**
  - Mac only — needs entirely separate codebases for PC, Web, Mobile
  - Most expensive to build and maintain

---

## 3. AI Integration Options

### A — GitHub Copilot Language Model API (VS Code only)
- Only available inside a VS Code extension
- User's selected model is passed directly via `request.model`
- Model swapping is automatic — user controls it in the chat UI
- Works with all models Copilot supports (GPT-4o, Claude 3.5 Sonnet, Gemini, o3-mini, etc.)
- **Best if:** we go the VS Code extension route

### B — GitHub Copilot Extensions (GitHub App)
- Build a GitHub App that acts as a Copilot chat participant
- Works on github.com, VS Code, Visual Studio — cross-surface
- Backed by a server (your API), not a local extension
- **Best if:** we want Copilot branding + multi-surface reach

### C — Direct AI APIs with model abstraction layer (Recommended for standalone app)
- Build a thin model-switcher: `interface AIProvider { complete(prompt, options) }`
- Plug in: OpenAI, Anthropic, Google Gemini, local (Ollama), etc.
- User can swap models in settings at any time
- No dependency on Copilot subscription
- Full control over context, system prompts, and streaming
- **Best if:** we build Tauri/Electron/Flutter

### D — MCP (Model Context Protocol)
- Open standard for connecting AI models to tools/data sources
- Already supported in VS Code, Cursor, JetBrains, Xcode
- Can run MCP servers locally or remotely
- **Available MCP servers today:**
  - `@modelcontextprotocol/server-filesystem` — file R/W
  - `@modelcontextprotocol/server-git` — git operations (log, diff, commit)
  - `@modelcontextprotocol/server-google-drive` — Google Drive access
  - Community servers for Notion, Obsidian, and more
  - GitHub MCP server (official, from GitHub)
- **Build custom MCP servers** to wrap our own tools (git history, content tracker, etc.)

---

## 4. Document & Content Format Support

| Format | Approach |
|---|---|
| **Markdown** | Native storage format — edit in custom editor or CodeMirror/Monaco |
| **PDF export** | Pandoc or Puppeteer (headless Chrome rendering) |
| **DOCX export** | Pandoc (`md → docx`) — handles styles, headings, images |
| **Grammarly** | Grammarly Text Editor SDK (JS) — works in any web-based editor (Tauri WebView, Electron, web) |
| **Google Docs** | Google Docs API v1 — import/export, collaborative editing bridge |
| **Google Slides** | Google Slides API v1 — create/update presentations programmatically. Community MCP servers exist. |

**Grammarly SDK note:** Grammarly's Text Editor SDK is a JavaScript library that plugs into `contenteditable` or custom editors. Works in any WebView-based app (Tauri, Electron) or web. No native mobile SDK — web view approach needed on mobile.

---

## 5. Google Slides / Presentation Support

- Google Slides API v1 (REST) — full CRUD on presentations, slides, text, images
- Can generate a full deck from structured content (course outline → slide deck)
- OAuth 2.0 required — user links their Google account
- Community MCP server exists: connects AI directly to Google Slides
- Alternative: generate Markdown → convert to Reveal.js or Marp (local, no Google dependency)

**Recommendation:** Support both:
1. Local slide view (Reveal.js / Marp) — no Google account needed
2. Google Slides export — for users who live in Google Workspace

---

## 6. Git Under the Hood

Every "project" (book, course, article set) is a git repo:

- Auto-init on project create
- Auto-commit on save (or on demand via sync script)
- Full history browsable in the app
- Branching for drafts ("v1-draft", "chapter-3-rewrite")
- **Libraries:**
  - Rust: `git2` crate (used in Tauri backend)
  - Node.js: `simple-git` or `isomorphic-git`
  - CLI: our `scripts/sync.sh` pattern, apply per-project

---

## 7. AI vs. Human Content Tracking

Each paragraph/block gets metadata tracking its origin:

```yaml
# Stored as YAML frontmatter or sidecar .meta.json
blocks:
  - id: "p-001"
    status: "ai-generated"    # ai-generated | human-edited | human-written | reviewed
    ai_model: "claude-3.5-sonnet"
    generated_at: "2026-02-22T14:30:00Z"
    reviewed_at: null
    reviewed_by: null
```

**UX flow:**
1. AI generates a paragraph/section → tagged `ai-generated`
2. User reads it in the editor → one-click "Mark as reviewed" per block
3. User edits it → auto-promotes to `human-edited`
4. Full status visible: "12 of 40 blocks reviewed" progress bar
5. Export can optionally embed or strip this metadata

**Git integration:** Each "mark as reviewed" action creates a micro-commit or is batched into the next save commit.

---

## 8. Stack Recommendation Summary

Based on the goals (Mac-primary, cross-platform, AI-first, non-coding users):

| Concern | Recommendation | Why |
|---|---|---|
| App framework | **Tauri v2** | Lightest, cross-platform including mobile (beta), full JS ecosystem |
| Frontend | **React + TypeScript** | Most AI-trainable, largest ecosystem, familiar |
| AI layer | **Direct API abstraction** (OpenAI/Anthropic/Gemini) | Model-agnostic, swap at will |
| Copilot integration | **GitHub Copilot Extension (GitHub App)** | Brings Copilot into the app without VS Code dependency |
| Document storage | **Markdown + YAML frontmatter** | Human-readable, git-friendly, exportable |
| Export | **Pandoc** | MD → PDF, DOCX, HTML in one tool |
| Grammarly | **Text Editor SDK** | Drop-in for any WebView editor |
| Slides | **Marp (local) + Google Slides API** | Cover both offline and Google Workspace workflows |
| AI tools | **MCP servers** | Filesystem, git, Google Drive already exist |
| Version history | **git (libgit2 / simple-git)** | Per-project git, auto-commit, sync script |
| AI/Human tracking | **YAML sidecar + git blame** | Lightweight, no database needed initially |

### Alternative if mobile is priority from day 1:
Replace Tauri with **Flutter** — accept the trade-offs on web/Grammarly SDK in exchange for production-ready iOS/Android from the start.

---

## 9. Open Questions to Decide

- [ ] Should the V1 be Mac-only (SwiftUI or Tauri, ship fast) or cross-platform from day 1?
- [ ] VS Code extension as a Phase 1 MVP (lowest friction, use existing Copilot UI), then standalone app as Phase 2?
- [ ] Self-hosted AI (Ollama/local models) a requirement, or cloud-only is fine?
- [ ] Google account required, or Google Slides is optional/later?
- [ ] Grammarly subscription required for users, or is basic spellcheck enough for V1?
- [ ] Mobile: can it wait until desktop is solid, or is it required at launch?

---

## 10. Suggested Next Steps

1. **Answer the open questions above** — shapes the phase 1 scope dramatically
2. **Define Phase 1 MVP** — likely: Tauri + React + Markdown editor + git + AI (one model) + basic AI/human tracking
3. **Scaffold the Tauri project** in this repo
4. **Prototype the content editor** with CodeMirror + Grammarly SDK
5. **Wire up one AI provider** (Anthropic or OpenAI) with a simple prompt interface
