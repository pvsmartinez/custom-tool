import { useState, useCallback, useEffect } from 'react';
import Editor from './components/Editor';
import AIPanel from './components/AIPanel';
import './App.css';

const STORAGE_KEY = 'custom-tool-doc';

const DEFAULT_CONTENT = `# Welcome to custom-tool

Start writing here. This is your Markdown editor.

## Tips

- Press **⌘K** (or **Ctrl+K**) to open Copilot and ask for help
- Your work is saved automatically in this session
- Markdown is fully supported: **bold**, *italic*, \`code\`, headings, lists

---

Start your first class, chapter, or article below.
`;

export default function App() {
  const [content, setContent] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CONTENT
  );
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState('');
  const [wordCount, setWordCount] = useState(0);

  // Persist to localStorage on every change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, content);
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    setWordCount(words);
  }, [content]);

  // Cmd/Ctrl+K at the app level (fallback)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setAiInitialPrompt('');
        setAiOpen(true);
      }
      if (e.key === 'Escape' && aiOpen) {
        setAiOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aiOpen]);

  const handleAIRequest = useCallback((selectedText: string) => {
    setAiInitialPrompt(
      selectedText ? `Help me with the following text:\n\n${selectedText}` : ''
    );
    setAiOpen(true);
  }, []);

  const handleInsert = useCallback((text: string) => {
    setContent((prev) => {
      const separator = prev.endsWith('\n') ? '\n' : '\n\n';
      return prev + separator + text;
    });
  }, []);

  // Extract a title from the first H1 in the document
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? 'Untitled';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <span className="app-logo">✦</span>
          <span className="app-title">{title}</span>
        </div>
        <div className="app-header-right">
          <span className="app-wordcount">{wordCount.toLocaleString()} words</span>
          <button
            className={`app-ai-toggle ${aiOpen ? 'active' : ''}`}
            onClick={() => setAiOpen((v) => !v)}
            title="Toggle Copilot panel (⌘K)"
          >
            ✦ Copilot
          </button>
        </div>
      </header>

      <div className="app-body">
        <Editor
          content={content}
          onChange={setContent}
          onAIRequest={handleAIRequest}
        />
        <AIPanel
          isOpen={aiOpen}
          onClose={() => setAiOpen(false)}
          initialPrompt={aiInitialPrompt}
          onInsert={handleInsert}
          documentContext={content}
        />
      </div>
    </div>
  );
}
