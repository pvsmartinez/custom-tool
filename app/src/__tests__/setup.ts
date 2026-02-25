import '@testing-library/jest-dom';
import React from 'react';
import { vi } from 'vitest';

// ── Mock Tauri plugin-fs ────────────────────────────────────────────────────
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readDir: vi.fn(),
  remove: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
}));

// ── Mock Tauri plugin-http ───────────────────────────────────────────────────
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

// ── Mock Tauri plugin-dialog ─────────────────────────────────────────────────
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

// ── Mock Tauri plugin-opener ─────────────────────────────────────────────────
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
  openPath: vi.fn(),
}));

// ── Mock Tauri core (invoke) ─────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// ── Mock tldraw ──────────────────────────────────────────────────────────────
vi.mock('tldraw', () => ({
  createShapeId: vi.fn(() => `shape:${Math.random().toString(36).slice(2)}`),
  renderPlaintextFromRichText: vi.fn((_editor: unknown, rt: { text?: string }) => rt?.text ?? ''),
  toRichText: vi.fn((text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [] }], text })),
  Tldraw: vi.fn(() => null),
}));

// ── Mock @uiw/react-codemirror ───────────────────────────────────────────────
// CodeMirror requires a real browser canvas/layout engine; swap it out with a
// lightweight textarea for component-level tests.
vi.mock('@uiw/react-codemirror', () => {
  const CodeMirrorMock = React.forwardRef(
    (
      props: {
        value?: string;
        onChange?: (val: string) => void;
        onCreateEditor?: (view: object) => void;
        height?: string;
        [key: string]: unknown;
      },
      _ref: unknown,
    ) => {
      const fakeView = {
        state: {
          doc: {
            toString: () => props.value ?? '',
            lines: (props.value ?? '').split('\n').length,
            line: (n: number) => {
              const lines = (props.value ?? '').split('\n');
              const lineText = lines[n - 1] ?? '';
              const from = lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
              return { from, text: lineText };
            },
          },
          selection: { main: { head: 0 } },
        },
        dispatch: vi.fn(),
        focus: vi.fn(),
        coordsAtPos: vi.fn(() => ({ top: 10, left: 20, bottom: 30, right: 100 })),
      };

      React.useEffect(() => {
        props.onCreateEditor?.(fakeView);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      return React.createElement('textarea', {
        'data-testid': 'codemirror-mock',
        defaultValue: props.value,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(e.target.value),
        style: { height: props.height },
      });
    },
  );
  CodeMirrorMock.displayName = 'CodeMirror';
  return { default: CodeMirrorMock };
});
