import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { vue } from '@codemirror/lang-vue';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { r } from '@codemirror/legacy-modes/mode/r';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap, history, indentWithTab } from '@codemirror/commands';
import { StateField, RangeSetBuilder, Compartment } from '@codemirror/state';
import { Decoration, DecorationSet } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import './Editor.css';

// ── Public handle exposed via ref ─────────────────────────────────────────────
export interface EditorHandle {
  /** Select and scroll to the first occurrence of `text` in the document.
   *  Returns true if found. */
  jumpToText(text: string): boolean;
  /** Move the cursor to a specific 1-based line number and centre the viewport. */
  jumpToLine(lineNo: number): void;
  /** Expose the raw CodeMirror EditorView so external search bars can drive it. */
  getView(): EditorView | null;
  /**
   * Returns the client-relative bounding rect of the first occurrence of `text`
   * in the editor, or null if the text isn't found.
   */
  getMarkCoords(text: string): { top: number; left: number; bottom: number; right: number } | null;
}

interface EditorProps {
  content: string;
  onChange: (value: string) => void;
  onAIRequest?: (selectedText: string) => void;
  /**
   * AI-generated marks to highlight.  Each entry carries the mark id and the
   * exact inserted text so edits inside a marked range auto-promote to reviewed.
   */
  aiMarks?: { id: string; text: string }[];
  /** Called when the user edits content that falls inside an AI-marked range. */
  onAIMarkEdited?: (markId: string) => void;
  /** Editor font size in pixels (default 14) */
  fontSize?: number;
  /** Whether the app is in dark mode — controls CodeMirror base theme (default true) */
  isDark?: boolean;
  /**
   * Called when the user pastes an image from the clipboard.
   * Should save the file and return its workspace-relative path (e.g. "images/paste-xxx.png"),
   * or null on failure.  When provided, a Markdown image reference is auto-inserted.
   */
  onImagePaste?: (file: File) => Promise<string | null>;
  /**
   * CodeMirror language hint: 'markdown' (default), 'html', 'css',
   * 'javascript', 'typescript', 'json', 'python', 'rust', 'yaml', 'shell', …
   * When set to anything other than 'markdown' (or empty), the editor switches
   * to a full-width code-editor layout with appropriate syntax highlighting.
   */
  language?: string;
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
function makeEditorTheme(fontSize: number, codeMode = false, isDark = true) {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: `${fontSize}px`,
      fontFamily: '"Maple Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
    },
    '.cm-scroller': {
      overflow: 'auto',
      overscrollBehavior: 'contain',
      padding: '0 0 120px 0',
    },
    '.cm-content': {
      // Prose mode: centred 720px column.  Code mode: full width, tighter padding.
      maxWidth: codeMode ? 'none' : '720px',
      margin: codeMode ? '0' : '0 auto',
      padding: codeMode ? '24px 16px' : '48px 24px',
      caretColor: '#4ec9b0',
      lineHeight: codeMode ? '1.55' : '1.75',
    },
    '.cm-line': {
      padding: '0',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor': {
      borderLeftColor: '#4ec9b0',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground': {
      background: '#3b3026 !important',
    },
    '.cm-ai-mark': {
      backgroundColor: 'rgba(212, 169, 106, 0.15)',
      borderBottom: '2px solid rgba(212, 169, 106, 0.7)',
      borderTop: '1px solid rgba(212, 169, 106, 0.3)',
      borderLeft: '1px solid rgba(212, 169, 106, 0.3)',
      borderRight: '1px solid rgba(212, 169, 106, 0.3)',
      borderRadius: '2px',
      boxShadow: '0 0 0 1px rgba(212, 169, 106, 0.1)',
    },
  }, { dark: isDark });
}

// ── Language extension resolver ───────────────────────────────────────────────
function getLanguageExtension(language: string): Extension {
  switch (language) {
    // ── First-class CodeMirror language packages ─────────────────────────────
    case 'html':        return html({ selfClosingTags: true });
    case 'css':         return css();
    case 'javascript':  return javascript({ jsx: true });
    case 'typescript':  return javascript({ jsx: true, typescript: true });
    case 'json':        return json();
    case 'python':      return python();
    case 'rust':        return rust();
    case 'yaml':        return yaml();
    case 'xml':         return xml();
    case 'go':          return go();
    case 'java':        return java();
    case 'cpp':         return cpp();
    case 'php':         return php();
    case 'sql':         return sql();
    case 'vue':         return vue();
    // Kotlin: no dedicated CM package; Java grammar gives reasonable highlighting
    case 'kotlin':      return java();
    // ── Legacy-mode languages (StreamLanguage wrapper) ───────────────────────
    case 'shell':       return StreamLanguage.define(shell);
    case 'toml':        return StreamLanguage.define(toml);
    case 'ruby':        return StreamLanguage.define(ruby);
    case 'lua':         return StreamLanguage.define(lua);
    case 'swift':       return StreamLanguage.define(swift);
    case 'diff':        return StreamLanguage.define(diff);
    case 'powershell':  return StreamLanguage.define(powerShell);
    case 'r':           return StreamLanguage.define(r);
    case 'perl':        return StreamLanguage.define(perl);
    // ── Markdown is handled by the outer branch; any unknown = plain text ────
    default:            return [];
  }
}

const DEFAULT_FONT_SIZE = 14;

// ── Component ─────────────────────────────────────────────────────────────────
const Editor = forwardRef<EditorHandle, EditorProps>(
  ({ content, onChange, onAIRequest, aiMarks, onAIMarkEdited, fontSize = DEFAULT_FONT_SIZE, onImagePaste, language, isDark = true }, ref) => {
    const codeMode = !!language && language !== 'markdown';
    const viewRef = useRef<EditorView | null>(null);
    const compartmentRef = useRef(new Compartment());
    const fontCompartmentRef = useRef(new Compartment());

    // Stable refs so the single update-listener always sees the latest values
    // without needing to be recreated on every render.
    const aiMarksRef = useRef<{ id: string; text: string }[]>([]);
    const onAIMarkEditedRef = useRef<((id: string) => void) | undefined>(undefined);
    aiMarksRef.current = aiMarks ?? [];
    onAIMarkEditedRef.current = onAIMarkEdited;

    // Created once – reads from refs so it stays live without cycling extensions.
    const aiMarkEditListener = useMemo(
      () =>
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const callback = onAIMarkEditedRef.current;
          if (!callback) return;
          const marks = aiMarksRef.current;
          if (marks.length === 0) return;

          const oldDoc = update.startState.doc.toString();
          const alreadyFired = new Set<string>();

          update.changes.iterChangedRanges((fromA, toA) => {
            for (const { id, text } of marks) {
              if (alreadyFired.has(id) || !text || text.length < 4) continue;
              let pos = 0;
              let idx: number;
              // A mark is "touched" if any instance of its text overlaps [fromA, toA).
              while ((idx = oldDoc.indexOf(text, pos)) !== -1) {
                if (idx < toA && idx + text.length > fromA) {
                  alreadyFired.add(id);
                  callback(id);
                  break;
                }
                pos = idx + text.length;
              }
            }
          });
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [], // intentionally empty — refs handle the live values
    );

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
      jumpToLine(lineNo: number): void {
        const view = viewRef.current;
        if (!view) return;
        const clampedLine = Math.max(1, Math.min(lineNo, view.state.doc.lines));
        const line = view.state.doc.line(clampedLine);
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true,
          effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        });
        view.focus();
      },
      getView(): EditorView | null {
        return viewRef.current;
      },
      getMarkCoords(text: string): { top: number; left: number; bottom: number; right: number } | null {
        const view = viewRef.current;
        if (!view) return null;
        const idx = view.state.doc.toString().indexOf(text);
        if (idx === -1) return null;
        const coords = view.coordsAtPos(idx);
        if (!coords) return null;
        return { top: coords.top, left: coords.left, bottom: coords.bottom, right: coords.right };
      },
    }));

    useEffect(() => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        effects: compartmentRef.current.reconfigure(
          makeAIMarkField((aiMarks ?? []).map((m) => m.text)),
        ),
      });
    }, [aiMarks]);

    // Reconfigure font size / theme dynamically
    useEffect(() => {
      if (!viewRef.current) return;
      viewRef.current.dispatch({
        effects: fontCompartmentRef.current.reconfigure(makeEditorTheme(fontSize, codeMode, isDark)),
      });
    }, [fontSize, codeMode, isDark]);

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

    // ── Clipboard image paste ─────────────────────────────────────────────────
    const handlePaste = useCallback(
      async (e: React.ClipboardEvent<HTMLDivElement>) => {
        if (!onImagePaste) return;
        const items = Array.from(e.clipboardData?.items ?? []);
        const imageItem = items.find((item) => item.type.startsWith('image/'));
        if (!imageItem) return;
        // There is an image — prevent CodeMirror's default paste handling
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return;
        const relPath = await onImagePaste(file);
        if (!relPath) return;
        const view = viewRef.current;
        if (!view) return;
        const pos = view.state.selection.main.head;
        const mdImage = `![](${ relPath })`;
        view.dispatch({
          changes: { from: pos, insert: mdImage },
          selection: { anchor: pos + mdImage.length },
        });
      },
      [onImagePaste],
    );

    const extensions = [
      // Language: use markdown (+ embedded code blocks) for prose, or the
      // file-specific grammar for code files.
      codeMode
        ? getLanguageExtension(language ?? '')
        : markdown({ base: markdownLanguage, codeLanguages: languages }),
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        // Tab key inserts real indentation in code files.
        // Note: searchKeymap intentionally excluded — FindReplaceBar handles all
        // search/replace for both prose and code modes (Cmd+F from App.tsx).
        ...(codeMode ? [indentWithTab] : []),
      ]),
      fontCompartmentRef.current.of(makeEditorTheme(fontSize, codeMode, isDark)),
      // Prose wraps; code does not
      ...(codeMode ? [] : [EditorView.lineWrapping]),
      compartmentRef.current.of(makeAIMarkField((aiMarks ?? []).map((m) => m.text))),
      aiMarkEditListener,
    ];

    return (
      <div className="editor-wrapper" onKeyDown={handleKeyDown} onPaste={handlePaste}>
        <CodeMirror
          value={content}
          onChange={onChange}
          extensions={extensions}
          theme={isDark ? oneDark : 'light'}
          height="100%"
          onCreateEditor={(view) => { viewRef.current = view; }}
          basicSetup={{
            lineNumbers: codeMode,
            foldGutter: codeMode,
            dropCursor: true,
            allowMultipleSelections: true,
            indentOnInput: true,
            bracketMatching: true,
            closeBrackets: true,
            // Autocompletion active in code mode only
            autocompletion: codeMode,
            rectangularSelection: codeMode,
            // Active line gutter highlight in code mode
            highlightActiveLine: codeMode,
            highlightActiveLineGutter: codeMode,
            highlightSelectionMatches: true,
            closeBracketsKeymap: true,
            // Search handled by our FindReplaceBar in prose mode;
            // in code mode we also wire in CM's own search keymap above.
            searchKeymap: false,
            tabSize: 2,
          }}
        />
      </div>
    );
  },
);

Editor.displayName = 'Editor';
export default Editor;
