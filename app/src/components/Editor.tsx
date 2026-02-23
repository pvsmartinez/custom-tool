import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history } from '@codemirror/commands';
import { StateField, RangeSetBuilder, Compartment } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import './Editor.css';

// ── Public handle exposed via ref ─────────────────────────────────────────────
export interface EditorHandle {
  /** Select and scroll to the first occurrence of `text` in the document.
   *  Returns true if found. */
  jumpToText(text: string): boolean;
}

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  onAIRequest?: (selectedText: string) => void;
  /** Exact text strings that were AI-generated; renders amber highlight. */
  aiMarkedTexts?: string[];
}

// ── AI-mark decoration helpers ────────────────────────────────────────────────
function buildAIDecorations(docText: string, texts: string[]): DecorationSet {
  const mark = Decoration.mark({ class: 'cm-ai-mark' });
  type R = { from: number; to: number };
  const ranges: R[] = [];

  for (const text of texts) {
    if (!text || text.length < 4) continue;
    let pos = 0;
    let idx: number;
    while ((idx = docText.indexOf(text, pos)) !== -1) {
      ranges.push({ from: idx, to: idx + text.length });
      pos = idx + text.length;
    }
  }

  ranges.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  let prevTo = -1;
  for (const r of ranges) {
    if (r.from >= prevTo && r.from < r.to) {
      builder.add(r.from, r.to, mark);
      prevTo = r.to;
    }
  }
  return builder.finish();
}

function makeAIMarkField(texts: string[]) {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildAIDecorations(state.doc.toString(), texts);
    },
    update(decs, tr) {
      return tr.docChanged
        ? buildAIDecorations(tr.newDoc.toString(), texts)
        : decs;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────
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
  '.cm-ai-mark': {
    backgroundColor: 'rgba(229, 192, 123, 0.13)',
    borderBottom: '1.5px solid rgba(229, 192, 123, 0.55)',
    borderRadius: '1px',
  },
}, { dark: true });

// ── Component ─────────────────────────────────────────────────────────────────
const Editor = forwardRef<EditorHandle, EditorProps>(
  ({ content, onChange, onAIRequest, aiMarkedTexts }, ref) => {
    const viewRef = useRef<EditorView | null>(null);
    const compartmentRef = useRef(new Compartment());

    useImperativeHandle(ref, () => ({
      jumpToText(text: string): boolean {
        const view = viewRef.current;
        if (!view) return false;
        const idx = view.state.doc.toString().indexOf(text);
        if (idx === -1) return false;
        view.dispatch({
          selection: { anchor: idx, head: idx + text.length },
          scrollIntoView: true,
          effects: EditorView.scrollIntoView(idx, { y: 'center' }),
        });
        view.focus();
        return true;
      },
    }));

    useEffect(() => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        effects: compartmentRef.current.reconfigure(
          makeAIMarkField(aiMarkedTexts ?? []),
        ),
      });
    }, [aiMarkedTexts]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          const selection = window.getSelection()?.toString() ?? '';
          onAIRequest?.(selection);
        }
      },
      [onAIRequest],
    );

    const extensions = [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      editorTheme,
      EditorView.lineWrapping,
      compartmentRef.current.of(makeAIMarkField(aiMarkedTexts ?? [])),
    ];

    return (
      <div className="editor-wrapper" onKeyDown={handleKeyDown}>
        <CodeMirror
          value={content}
          onChange={onChange}
          extensions={extensions}
          theme={oneDark}
          height="100%"
          onCreateEditor={(view) => { viewRef.current = view; }}
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
  },
);

Editor.displayName = 'Editor';
export default Editor;
