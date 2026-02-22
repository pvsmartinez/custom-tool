import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Editor from './components/Editor';
import AIPanel from './components/AIPanel';
import WorkspacePicker from './components/WorkspacePicker';
import Sidebar from './components/Sidebar';
import {
  readFile,
  writeFile,
} from './services/workspace';
import type { Workspace } from './types';
import './App.css';

const FALLBACK_CONTENT = `# Untitled Document\n\nStart writing here…\n`;

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>(FALLBACK_CONTENT);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [updating, setUpdating] = useState<'idle' | 'building' | 'error'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── In-app update ───────────────────────────────────────────
  async function handleUpdate() {
    setUpdating('building');
    setUpdateError(null);
    try {
      // __PROJECT_ROOT__ is embedded by vite.config.ts at build time
      await invoke('update_app', { projectRoot: __PROJECT_ROOT__ });
      // process exits inside the Rust command — we never reach here
    } catch (err) {
      setUpdating('error');
      setUpdateError(String(err));
    }
  }

  // ── Word count ───────────────────────────────────────────────
  useEffect(() => {
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    setWordCount(words);
  }, [content]);

  // ── Keyboard shortcuts ───────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setAiInitialPrompt('');
        setAiOpen(true);
      }
      if (e.key === 'Escape' && aiOpen) setAiOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aiOpen]);

  // ── File open ────────────────────────────────────────────────
  async function handleOpenFile(filename: string) {
    if (!workspace) return;
    try {
      const text = await readFile(workspace, filename);
      setContent(text);
      setActiveFile(filename);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }

  // ── File create (delegated to Sidebar) ────────────────────────────────────
  function handleFilesChange(files: string[]) {
    setWorkspace((prev) => prev ? { ...prev, files } : null);
  }

  function handleWorkspaceChange(ws: Workspace) {
    setWorkspace(ws);
    const target = ws.config.lastOpenedFile ?? ws.files[0] ?? null;
    if (target) {
      readFile(ws, target)
        .then((text) => { setContent(text); setActiveFile(target); })
        .catch(() => { setContent(FALLBACK_CONTENT); setActiveFile(null); });
    } else {
      setContent(FALLBACK_CONTENT);
      setActiveFile(null);
    }
  }

  // ── Auto-save (debounced 1s) ─────────────────────────────────
  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent);
      if (!workspace || !activeFile) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          await writeFile(workspace, activeFile, newContent);
        } catch (err) {
          console.error('Auto-save failed:', err);
        }
      }, 1000);
    },
    [workspace, activeFile]
  );

  // ── AI request from editor (⌘K selection) ───────────────────
  const handleAIRequest = useCallback((selectedText: string) => {
    setAiInitialPrompt(
      selectedText ? `Help me improve this:\n\n${selectedText}` : ''
    );
    setAiOpen(true);
  }, []);

  // ── Insert from AI ───────────────────────────────────────────
  const handleInsert = useCallback((text: string) => {
    setContent((prev) => {
      const sep = prev.endsWith('\n') ? '\n' : '\n\n';
      return prev + sep + text;
    });
  }, []);

  // ── Workspace loaded ─────────────────────────────────────────
  async function handleWorkspaceLoaded(ws: Workspace) {
    setWorkspace(ws);
    // Open the last opened file, or the first .md file
    const target = ws.config.lastOpenedFile ?? ws.files[0] ?? null;
    if (target) {
      try {
        const text = await readFile(ws, target);
        setContent(text);
        setActiveFile(target);
      } catch {
        setContent(FALLBACK_CONTENT);
        setActiveFile(null);
      }
    } else {
      setContent(FALLBACK_CONTENT);
      setActiveFile(null);
    }
  }

  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? activeFile ?? 'Untitled';

  // ── No workspace yet — show picker ──────────────────────────
  if (!workspace) {
    return <WorkspacePicker onOpen={handleWorkspaceLoaded} />;
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="app-header-left">
          <span className="app-logo">✦</span>
          <span className="app-title">{title}</span>
          {workspace.config.name && (
            <span className="app-workspace-name">{workspace.config.name}</span>
          )}
        </div>
        <div className="app-header-right">
          <span className="app-wordcount">{wordCount.toLocaleString()} words</span>
          {updating === 'building' && (
            <span className="app-updating">⟳ Building update…</span>
          )}
          {updating === 'error' && updateError && (
            <span className="app-update-error" title={updateError}>⚠ Update failed</span>
          )}
          <button
            className="app-update-btn"
            onClick={handleUpdate}
            disabled={updating === 'building'}
            title="Rebuild and reinstall the app"
          >
            {updating === 'building' ? '…' : '↑ Update'}
          </button>
          <button
            className={`app-ai-toggle ${aiOpen ? 'active' : ''}`}
            onClick={() => setAiOpen((v) => !v)}
            title="Toggle Copilot panel (⌘K)"
          >
            ✦ Copilot
          </button>
        </div>
      </header>

      {/* Main 3-column body */}
      <div className="app-body">
        <Sidebar
          workspace={workspace}
          activeFile={activeFile}
          onFileSelect={handleOpenFile}
          onWorkspaceChange={handleWorkspaceChange}
          onFilesChange={handleFilesChange}
        />

        <Editor
          content={content}
          onChange={handleContentChange}
          onAIRequest={handleAIRequest}
        />

        <AIPanel
          isOpen={aiOpen}
          onClose={() => setAiOpen(false)}
          initialPrompt={aiInitialPrompt}
          onInsert={handleInsert}
          documentContext={content}
          agentContext={workspace.agentContext}
        />
      </div>
    </div>
  );
}

