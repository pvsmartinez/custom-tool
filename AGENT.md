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

- macOS-first native experience (likely Swift / SwiftUI or Electron)
- Web version as a secondary surface
- AI integration at the core (OpenAI / Anthropic / local models TBD)
- VS Code Copilot-style UX adapted for general-purpose workflows

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

- **2026-02-22 (init)** — Project initialized. Repo created on GitHub. Core infrastructure (git, scripts, AGENT.md) in place. Vision: AI productivity tool beyond coding.
- **2026-02-22 (brainstorm)** — Full capability & stack brainstorm completed. See `docs/brainstorm.md`. Leading stack candidate: **Tauri v2 + React/TypeScript** for the standalone app. Key capabilities: Markdown-native writing, PDF/DOCX export, Grammarly SDK, AI model abstraction layer (swap providers freely), MCP bridges, Google Slides API, git-per-project, AI vs. Human content tracking. Open questions logged in brainstorm — need decisions on: V1 platform scope, VS Code extension as MVP vs. standalone, mobile priority.
