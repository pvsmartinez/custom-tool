# Brainstorm — Cafezin

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

## 9. Decisions Made (2026-02-22)

| Question | Decision |
|---|---|
| Platform scope | Mac-primary + Windows, cross-platform from day 1 via Tauri v2 |
| Backend | **No backend** — pure client, call services directly (git local, Google APIs, AI APIs) |
| AI provider | **Cloud-only** — Anthropic (Claude) as primary; self-hosting later if needed |
| Google Slides | **Required** — humans edit directly in Google Slides (drag/drop, fonts, etc.); app manages content via Slides API |
| Mobile scope | **View-only + voice control** — see projects/slides/PDFs; voice input → AI commands; no editing UI needed |
| Voice control | **Must-have** — Web Speech API in WebView covers desktop + mobile |
| Primary user | Personal use; architecture kept clean enough to commercialize later |
| VS Code extension | Not the app — too constrained for non-coders. Copilot integration via GitHub App + direct API. |

---

## 10. Stack Decision — Final

### ✅ Tauri v2 + React + TypeScript

**Why Tauri beats the alternatives:**

**vs. Electron:**  
Electron is what VS Code and Cursor are built on. Cursor specifically is a *fork of VS Code itself* — they didn't build an extension, they took the entire VS Code source code, modified its internals deeply (added inline AI, changed the editor core), and ship it as a separate app. That's a massive undertaking and requires maintaining a fork of millions of lines of code. We don't need that. Tauri gives us the same "web tech + native shell" model but ~10 MB vs ~150 MB, lower memory, and we own the whole thing cleanly.

**vs. Flutter:**  
Flutter is excellent for mobile-first apps. But its web output is weaker, and the Google Slides embed + Grammarly SDK are JS-native — they work in a WebView natively in Tauri. In Flutter you'd need to add a WebView widget on top anyway, negating the main advantage. Dart also has far less AI tooling muscle behind it.

**vs. VS Code Extension:**  
Too constrained for a general user. Can't build a real document editor, can't embed Google Slides, can't do a mobile app. Fine as a developer productivity add-on, not right for this tool.

**Why Tauri fits perfectly:**
- **No backend needed** — Tauri's Rust core calls git directly via `git2` crate (local, no server). AI calls go to Anthropic/OpenAI REST APIs from the frontend. Google APIs are OAuth + REST, same.
- **Google Slides** — app generates content → pushes via Slides API → user opens Google Slides in their browser to edit manually → app can embed a read-only view via `<webview>`
- **Voice control** — Web Speech API (`SpeechRecognition`) works in Tauri's WKWebView on macOS and in mobile WebView. No extra library needed.
- **Mobile (Phase 2)** — Tauri v2 has iOS + Android support (beta, but stable enough for view-only + voice). Perfect fit since we're not building a full mobile editor.
- **Grammarly** — Text Editor SDK works in the WebView (it's a JS library, drops into any `contenteditable`)
- **React/TypeScript** — largest ecosystem, best AI tool support, easiest to maintain

### Architecture (No Backend)

```
┌─────────────────────────────────────────────────────┐
│                  Tauri v2 App Shell                  │
│  ┌───────────────────────────────────────────────┐  │
│  │         React + TypeScript Frontend            │  │
│  │  ┌──────────────┐  ┌────────────────────────┐ │  │
│  │  │ Markdown     │  │ Google Slides          │ │  │
│  │  │ Editor       │  │ Embed / API bridge     │ │  │
│  │  │ (CodeMirror) │  │                        │ │  │
│  │  │ + Grammarly  │  └────────────────────────┘ │  │
│  │  │ SDK          │                              │  │
│  │  └──────────────┘  ┌────────────────────────┐ │  │
│  │                    │ Voice Input            │ │  │
│  │                    │ (Web Speech API)       │ │  │
│  │                    └────────────────────────┘ │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │              Rust (Tauri) Backend              │  │
│  │  • git2 crate — local git per project         │  │
│  │  • File system access (MD files, exports)     │  │
│  │  • Pandoc subprocess (PDF / DOCX export)     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │                │
         ▼                    ▼                ▼
  Anthropic API        Google APIs         (no server)
  (Claude — direct)   (Slides, Drive,
                        OAuth 2.0)
```

---

## 11. Google Slides Integration Model

Since users want to edit slides directly in Google Slides (drag/drop, fonts, etc.), the flow is:

1. **Generate:** AI creates structured content (outline, bullet points) in the app
2. **Push:** App calls Google Slides API → creates/updates the presentation
3. **Edit:** User opens Google Slides in browser — edits freely, no app involved
4. **View:** App embeds a read-only preview via iframe (Google Slides publish embed)
5. **AI/Human tracking:** Slide-level metadata stored in our YAML/JSON sidecar — "this slide was AI-generated, not yet reviewed"

This means **we don't build a slide editor** — Google Slides is the slide editor. We're the AI that creates and organizes the content, and Google Slides is the canvas.

---

## 12. Mobile Strategy

| Feature | Desktop | Mobile |
|---|---|---|
| Write / edit content | ✅ Full editor | ❌ Not needed |
| View slides / PDFs | ✅ | ✅ Embed/WebView |
| Voice → AI command | ✅ | ✅ Web Speech API |
| AI generates content | ✅ | ✅ (same API calls) |
| Mark blocks as reviewed | ✅ | ✅ Simple tap |
| Git sync | ✅ Full | 🔄 Read-only / manual sync |

Mobile is essentially a **companion viewer + voice interface**. Tauri v2's mobile target handles this well.

---

## 13. Phase Plan

### Phase 1 — Mac Desktop MVP
- Tauri v2 + React/TS scaffolding
- Markdown editor (CodeMirror) + Grammarly SDK
- One AI provider (Anthropic / Claude) wired up
- Git per project (init, auto-commit, sync script)
- AI/Human block tracking (basic YAML metadata)
- Export to PDF (Pandoc) and DOCX

### Phase 2 — Google Integration
- Google OAuth 2.0
- Google Slides API: create presentations from content
- Google Drive API: backup/sync projects
- Slides embed in-app viewer

### Phase 3 — Mobile
- Tauri v2 iOS/Android build
- View projects, slides, PDFs
- Voice input → AI text generation
- Review/approve blocks on mobile

### Phase 4 — Polish / Multi-user (if commercializing)
- Multi-model support (OpenAI, Gemini, local via Ollama)
- Grammarly deep integration
- Team sharing / collaboration features

---

## 14. Suggested Next Steps

1. **Scaffold Tauri v2 + React/TS project** in this repo
2. **Get a Markdown editor running** (CodeMirror 6)
3. **Wire up Anthropic API** — simple prompt → response in the editor
4. **Add git auto-init** per project using Tauri's Rust commands + `git2`
5. **Add AI/Human block tracking** — YAML frontmatter schema + basic UI indicator
