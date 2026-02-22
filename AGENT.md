# AGENT.md — Project Context for AI Sessions

## Project: custom-tool

**Owner:** Pedro Martinez (pvsmartinez@gmail.com)  
**Repo:** https://github.com/pvsmartinez/custom-tool  
**Started:** February 2026

---

## What We Are Building

A general-purpose AI-assisted productivity tool, inspired by how Pedro uses VS Code + GitHub Copilot — but **not** focused on coding. The tool is designed to support creative, educational, and knowledge-work workflows, including:

- ✍️ Writing books and long-form content  
- 📚 Creating classes, courses, and curricula  
- 🗂️ Knowledge management and note-taking  
- 🤖 AI-powered workflows for non-technical users  
- Other productivity and content-creation use cases  

---

## Target Platforms

| Platform | Priority | Notes |
|---|---|---|
| macOS (native app) | Primary | Pedro's daily driver |
| PC / Windows | Secondary | Cross-platform support |
| Web app | Planned | Broader accessibility |
| iPhone | Future | Mobile companion |
| Android | Future | Mobile companion |

---

## Technical Direction

- **Framework:** Tauri v2 (Rust backend + React/TypeScript frontend)
- **No backend server** — pure client; talks directly to Anthropic API, Google APIs, local git
- **AI:** Anthropic (Claude) cloud API — model abstraction layer for future swapping
- **Documents:** Markdown + YAML frontmatter (git-friendly, exportable)
- **Slides:** Google Slides API — app generates content, users edit in Google Slides natively
- **Export:** Pandoc (MD → PDF, DOCX)
- **Grammar:** Grammarly Text Editor SDK (WebView, JS)
- **Voice:** Web Speech API — desktop and mobile
- **Version control:** git per project, `git2` Rust crate, auto-commit
- **AI/Human tracking:** YAML block metadata — `ai-generated` → `human-edited` → `reviewed`
- **Mobile:** View-only + voice control (Tauri v2 iOS/Android, Phase 3)

---

## Project Structure

```
custom-tool/
├── docs/
│   └── brainstorm.md # Capability & stack brainstorm (session 2026-02-22)
├── scripts/          # Utility shell scripts
│   └── sync.sh       # Quick git add-all → commit → push
├── AGENT.md          # This file — AI session context
└── README.md         # Human-facing project overview
```

---

## Session Notes

_Add notes here as work progresses across sessions to maintain continuity._

- **2026-02-22 (init)** — Project initialized. Repo created on GitHub. Core infrastructure (git, scripts, AGENT.md) in place.
- **2026-02-22 (brainstorm)** — Full capability & stack brainstorm. See `docs/brainstorm.md`.
- **2026-02-22 (decision)** — Stack decided: **Tauri v2 + React/TypeScript**. No backend. Claude (Anthropic) as primary AI. Google Slides for presentations (users edit there directly). Mobile = view + voice only. Voice via Web Speech API. git per project via Rust git2 crate. Next step: scaffold Tauri v2 project.
