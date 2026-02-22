import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history } from '@codemirror/commands';
import { useCallback } from 'react';
import './Editor.css';

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  onAIRequest?: (selectedText: string) => void;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '16px',
    fontFamily: '"iA Writer Quattro", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
  },
  '.cm-scroller': {
    overflow: 'auto',
    padding: '0 0 120px 0',
  },
  '.cm-content': {
    maxWidth: '720px',
    margin: '0 auto',
    padding: '48px 24px',
    caretColor: '#61afef',
    lineHeight: '1.75',
  },
  '.cm-line': {
    padding: '0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor': {
    borderLeftColor: '#61afef',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': {
    background: '#3e4451 !important',
  },
}, { dark: true });

export default function Editor({ content, onChange, onAIRequest }: EditorProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd+K (macOS) or Ctrl+K → open AI panel with selection
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const selection = window.getSelection()?.toString() ?? '';
        onAIRequest?.(selection);
      }
    },
    [onAIRequest]
  );

  const extensions = [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    editorTheme,
    EditorView.lineWrapping,
  ];

  return (
    <div className="editor-wrapper" onKeyDown={handleKeyDown}>
      <CodeMirror
        value={content}
        onChange={onChange}
        extensions={extensions}
        theme={oneDark}
        height="100%"
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: true,
          highlightActiveLine: false,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          searchKeymap: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
