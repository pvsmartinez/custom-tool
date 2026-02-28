import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { createRef } from 'react';
import Editor from '../components/Editor';
import type { EditorHandle } from '../components/Editor';

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderEditor(props: Partial<React.ComponentProps<typeof Editor>> = {}) {
  const defaultProps = {
    content: 'Hello world\nSecond line\nThird line',
    onChange: vi.fn(),
  };
  const ref = createRef<EditorHandle>();
  const { rerender, unmount } = render(
    <Editor ref={ref} {...defaultProps} {...props} />,
  );
  return { ref, rerender, unmount, onChange: defaultProps.onChange };
}

// ── Rendering ─────────────────────────────────────────────────────────────────
describe('Editor — rendering', () => {
  it('renders the editor-wrapper div', () => {
    const { container } = render(
      <Editor content="test" onChange={vi.fn()} />,
    );
    expect(container.querySelector('.editor-wrapper')).toBeInTheDocument();
  });

  it('renders the mocked CodeMirror textarea', () => {
    renderEditor({ content: 'Hello there' });
    expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument();
  });

  it('passes content to CodeMirror', () => {
    renderEditor({ content: 'My content' });
    const textarea = screen.getByTestId('codemirror-mock') as HTMLTextAreaElement;
    expect(textarea.defaultValue).toBe('My content');
  });

  it('renders in code mode when language prop is set', async () => {
    renderEditor({ content: 'const x = 1', language: 'javascript' });
    expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument();
  });

  it('renders without crashing when aiMarks prop is provided', () => {
    renderEditor({
      aiMarks: [{ id: 'mark-1', text: 'Hello world' }],
    });
    expect(screen.getByTestId('codemirror-mock')).toBeInTheDocument();
  });
});

// ── EditorHandle — jumpToText ─────────────────────────────────────────────────
describe('EditorHandle.jumpToText', () => {
  it('returns true when text is found in the document', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="The quick brown fox" onChange={vi.fn()} />);

    // wait for the useEffect in the mock to fire (onCreateEditor)
    await act(async () => {});

    const found = ref.current?.jumpToText('quick');
    expect(found).toBe(true);
  });

  it('returns false when text is not found', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="Hello world" onChange={vi.fn()} />);
    await act(async () => {});

    expect(ref.current?.jumpToText('notinhere')).toBe(false);
  });

  it('dispatches a selection to the view when text is found', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="find me please" onChange={vi.fn()} />);
    await act(async () => {});

    ref.current?.jumpToText('find me');
    const view = ref.current?.getView();
    expect(view?.dispatch).toHaveBeenCalled();
  });
});

// ── EditorHandle — jumpToLine ─────────────────────────────────────────────────
describe('EditorHandle.jumpToLine', () => {
  it('dispatches to the view for a valid line number', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="Line 1\nLine 2\nLine 3" onChange={vi.fn()} />);
    await act(async () => {});

    ref.current?.jumpToLine(2);
    expect(ref.current?.getView()?.dispatch).toHaveBeenCalled();
  });

  it('clamps to line 1 when given a negative line number', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="One line" onChange={vi.fn()} />);
    await act(async () => {});

    // Should not throw
    expect(() => ref.current?.jumpToLine(-5)).not.toThrow();
    expect(ref.current?.getView()?.dispatch).toHaveBeenCalled();
  });

  it('clamps to the last line when given an out-of-range number', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="Line 1\nLine 2" onChange={vi.fn()} />);
    await act(async () => {});

    expect(() => ref.current?.jumpToLine(9999)).not.toThrow();
    expect(ref.current?.getView()?.dispatch).toHaveBeenCalled();
  });
});

// ── EditorHandle — getView ────────────────────────────────────────────────────
describe('EditorHandle.getView', () => {
  it('returns the EditorView after mount', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="" onChange={vi.fn()} />);
    await act(async () => {});

    const view = ref.current?.getView();
    expect(view).not.toBeNull();
    expect(typeof view?.dispatch).toBe('function');
  });
});

// ── EditorHandle — getMarkCoords ──────────────────────────────────────────────
describe('EditorHandle.getMarkCoords', () => {
  it('returns coordinates when the text is present', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="locate this text" onChange={vi.fn()} />);
    await act(async () => {});

    const coords = ref.current?.getMarkCoords('locate');
    expect(coords).not.toBeNull();
    expect(coords).toMatchObject({
      top: expect.any(Number),
      left: expect.any(Number),
      bottom: expect.any(Number),
      right: expect.any(Number),
    });
  });

  it('returns null when the text is not in the document', async () => {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="some content" onChange={vi.fn()} />);
    await act(async () => {});

    const coords = ref.current?.getMarkCoords('doesnotexist');
    expect(coords).toBeNull();
  });
});

// ── Keyboard shortcut — Cmd+K ─────────────────────────────────────────────────
describe('Editor — Cmd+K shortcut', () => {
  it('calls onAIRequest when Cmd+K is pressed', async () => {
    const onAIRequest = vi.fn();
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} onAIRequest={onAIRequest} />,
    );
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'k', metaKey: true });
    expect(onAIRequest).toHaveBeenCalledOnce();
  });

  it('calls onAIRequest when Ctrl+K is pressed', async () => {
    const onAIRequest = vi.fn();
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} onAIRequest={onAIRequest} />,
    );
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'k', ctrlKey: true });
    expect(onAIRequest).toHaveBeenCalledOnce();
  });

  it('does not call onAIRequest on other keys', async () => {
    const onAIRequest = vi.fn();
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} onAIRequest={onAIRequest} />,
    );
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'Enter' });
    fireEvent.keyDown(wrapper, { key: 'k' }); // without meta/ctrl
    expect(onAIRequest).not.toHaveBeenCalled();
  });

  it('does not throw when onAIRequest is not provided', async () => {
    const { container } = render(<Editor content="text" onChange={vi.fn()} />);
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    expect(() =>
      fireEvent.keyDown(wrapper, { key: 'k', metaKey: true }),
    ).not.toThrow();
  });
});

// ── Image paste ───────────────────────────────────────────────────────────────
describe('Editor — image paste', () => {
  it('calls onImagePaste with the image file when an image is pasted', async () => {
    const onImagePaste = vi.fn().mockResolvedValue('images/pasted.png');
    const { container } = render(
      <Editor content="" onChange={vi.fn()} onImagePaste={onImagePaste} />,
    );
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    const imageFile = new File(['png-data'], 'paste.png', { type: 'image/png' });

    // jsdom does not expose DataTransfer — construct a plain clipboard mock
    fireEvent.paste(wrapper, {
      clipboardData: {
        items: [{ type: 'image/png', getAsFile: () => imageFile }],
        getData: () => '',
      },
    });
    await waitFor(() => {
      expect(onImagePaste).toHaveBeenCalledOnce();
      expect(onImagePaste.mock.calls[0][0]).toBeInstanceOf(File);
    });
  });

  it('does not call onImagePaste when pasting plain text', async () => {
    const onImagePaste = vi.fn();
    const { container } = render(
      <Editor content="" onChange={vi.fn()} onImagePaste={onImagePaste} />,
    );
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    // No image item — only text
    fireEvent.paste(wrapper, {
      clipboardData: {
        items: [{ type: 'text/plain', getAsFile: () => null }],
        getData: (_type: string) => 'just text',
      },
    });
    await act(async () => {});
    expect(onImagePaste).not.toHaveBeenCalled();
  });

  it('does not throw when no onImagePaste handler is provided', async () => {
    const { container } = render(<Editor content="" onChange={vi.fn()} />);
    await act(async () => {});

    const wrapper = container.querySelector('.editor-wrapper')!;
    const imageFile = new File(['data'], 'img.png', { type: 'image/png' });

    expect(() =>
      fireEvent.paste(wrapper, {
        clipboardData: {
          items: [{ type: 'image/png', getAsFile: () => imageFile }],
          getData: () => '',
        },
      }),
    ).not.toThrow();
  });
});

// ── onChange propagation ──────────────────────────────────────────────────────
describe('Editor — onChange', () => {
  it('fires onChange when the mocked textarea value changes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Editor content="" onChange={onChange} />);
    await act(async () => {});

    const textarea = screen.getByTestId('codemirror-mock');
    await user.type(textarea, 'hi');
    // userEvent.type fires change events per character
    expect(onChange).toHaveBeenCalled();
  });
});

// ── Markdown toolbar — rendering ──────────────────────────────────────────────
describe('Editor — markdown toolbar rendering', () => {
  it('renders the markdown toolbar in prose mode', () => {
    const { container } = render(<Editor content="" onChange={vi.fn()} />);
    expect(container.querySelector('.editor-md-toolbar')).toBeInTheDocument();
  });

  it('does NOT render the markdown toolbar in code mode', () => {
    const { container } = render(
      <Editor content="" onChange={vi.fn()} language="javascript" />,
    );
    expect(container.querySelector('.editor-md-toolbar')).not.toBeInTheDocument();
  });

  it('renders a button for every MD_TOOLBAR item', () => {
    const { container } = render(<Editor content="" onChange={vi.fn()} />);
    const buttons = container.querySelectorAll('.editor-md-toolbar-btn');
    // 16 items defined in MD_TOOLBAR_ITEMS
    expect(buttons.length).toBe(16);
  });

  it('has a Bold button with correct title', () => {
    render(<Editor content="" onChange={vi.fn()} />);
    expect(screen.getByTitle('Bold (⌘B)')).toBeInTheDocument();
  });

  it('has an Italic button with correct title', () => {
    render(<Editor content="" onChange={vi.fn()} />);
    expect(screen.getByTitle('Italic (⌘I)')).toBeInTheDocument();
  });

  it('has a Math block button with correct title', () => {
    render(<Editor content="" onChange={vi.fn()} />);
    expect(screen.getByTitle('Math block (KaTeX)')).toBeInTheDocument();
  });
});

// ── Markdown toolbar — button actions ─────────────────────────────────────────
describe('Editor — toolbar button actions', () => {
  async function getViewDispatch() {
    const ref = createRef<EditorHandle>();
    render(<Editor ref={ref} content="hello" onChange={vi.fn()} />);
    await act(async () => {});
    const dispatch = ref.current!.getView()!.dispatch as ReturnType<typeof vi.fn>;
    dispatch.mockClear();
    return { ref, dispatch };
  }

  it('Bold button dispatches a change wrapping with **', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Bold (⌘B)');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('**');
  });

  it('Italic button dispatches a change wrapping with _', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Italic (⌘I)');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('_');
  });

  it('Strikethrough button dispatches a change wrapping with ~~', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Strikethrough');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('~~');
  });

  it('Inline code button dispatches a change wrapping with backtick', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Inline code');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('`');
  });

  it('Horizontal rule button dispatches an insert of ---', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Horizontal rule');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('---');
  });

  it('Link button dispatches a change containing [text](url)', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Link');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toMatch(/\[.*\]\(url\)/);
  });

  it('Image button dispatches a change containing ![alt text](url)', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Image');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toMatch(/!\[.*\]\(url\)/);
  });

  it('Code block button dispatches a change with triple backtick fence', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Code block');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('```');
  });

  it('Table button dispatches a change containing | Col', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Table');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('| Col');
  });

  it('Math block button dispatches a change with $$', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Math block (KaTeX)');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('$$');
  });

  it('H1 button dispatches a prefix insert (dispatch called)', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Heading 1');
    fireEvent.mouseDown(btn);
    // prefix-type items dispatch with changes containing '# '
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toBe('# ');
  });

  it('Blockquote button dispatches a prefix insert with > ', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Blockquote');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toBe('> ');
  });

  it('Bullet list button dispatches a prefix insert with - ', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Bullet list');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toBe('- ');
  });

  it('Numbered list button dispatches a prefix insert with 1. ', async () => {
    const { dispatch } = await getViewDispatch();
    const btn = screen.getByTitle('Numbered list');
    fireEvent.mouseDown(btn);
    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toBe('1. ');
  });
});

// ── Keyboard shortcuts — Cmd+B / Cmd+I (prose mode) ──────────────────────────
describe('Editor — Cmd+B / Cmd+I prose shortcuts', () => {
  it('Cmd+B dispatches a bold wrap in prose mode', async () => {
    const ref = createRef<EditorHandle>();
    const { container } = render(
      <Editor ref={ref} content="text" onChange={vi.fn()} />,
    );
    await act(async () => {});
    const dispatch = ref.current!.getView()!.dispatch as ReturnType<typeof vi.fn>;
    dispatch.mockClear();

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'b', metaKey: true });

    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('**');
  });

  it('Ctrl+B dispatches a bold wrap in prose mode', async () => {
    const ref = createRef<EditorHandle>();
    const { container } = render(
      <Editor ref={ref} content="text" onChange={vi.fn()} />,
    );
    await act(async () => {});
    const dispatch = ref.current!.getView()!.dispatch as ReturnType<typeof vi.fn>;
    dispatch.mockClear();

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'b', ctrlKey: true });

    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('**');
  });

  it('Cmd+I dispatches an italic wrap in prose mode', async () => {
    const ref = createRef<EditorHandle>();
    const { container } = render(
      <Editor ref={ref} content="text" onChange={vi.fn()} />,
    );
    await act(async () => {});
    const dispatch = ref.current!.getView()!.dispatch as ReturnType<typeof vi.fn>;
    dispatch.mockClear();

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'i', metaKey: true });

    expect(dispatch).toHaveBeenCalled();
    const call = dispatch.mock.calls[0][0];
    expect(call.changes.insert).toContain('_');
  });

  it('Cmd+B does NOT dispatch in code mode', async () => {
    const ref = createRef<EditorHandle>();
    const { container } = render(
      <Editor ref={ref} content="code" onChange={vi.fn()} language="javascript" />,
    );
    await act(async () => {});
    const dispatch = ref.current!.getView()!.dispatch as ReturnType<typeof vi.fn>;
    dispatch.mockClear();

    const wrapper = container.querySelector('.editor-wrapper')!;
    fireEvent.keyDown(wrapper, { key: 'b', metaKey: true });

    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ── Code mode toolbar ─────────────────────────────────────────────────────────
describe('Editor — code mode toolbar', () => {
  it('renders the Format button when language + onFormat are provided', () => {
    render(
      <Editor
        content="const x = 1"
        onChange={vi.fn()}
        language="javascript"
        onFormat={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Format file (Prettier)')).toBeInTheDocument();
  });

  it('does NOT render the Format button when onFormat is not provided', () => {
    render(
      <Editor content="const x = 1" onChange={vi.fn()} language="javascript" />,
    );
    expect(screen.queryByTitle('Format file (Prettier)')).not.toBeInTheDocument();
  });

  it('does NOT render the Format button in prose mode', () => {
    const onFormat = vi.fn();
    render(<Editor content="text" onChange={vi.fn()} onFormat={onFormat} />);
    expect(screen.queryByTitle('Format file (Prettier)')).not.toBeInTheDocument();
  });

  it('calls onFormat when the Format button is clicked', async () => {
    const onFormat = vi.fn();
    render(
      <Editor
        content="const x = 1"
        onChange={vi.fn()}
        language="javascript"
        onFormat={onFormat}
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByTitle('Format file (Prettier)'));
    expect(onFormat).toHaveBeenCalledOnce();
  });
});

// ── isLocked prop ─────────────────────────────────────────────────────────────
describe('Editor — isLocked prop', () => {
  it('sets data-locked attribute when isLocked=true', () => {
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} isLocked={true} />,
    );
    const wrapper = container.querySelector('.editor-wrapper');
    expect(wrapper).toHaveAttribute('data-locked', 'true');
  });

  it('does NOT set data-locked when isLocked=false', () => {
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} isLocked={false} />,
    );
    const wrapper = container.querySelector('.editor-wrapper');
    expect(wrapper).not.toHaveAttribute('data-locked');
  });

  it('does NOT set data-locked when isLocked is omitted', () => {
    const { container } = render(<Editor content="text" onChange={vi.fn()} />);
    const wrapper = container.querySelector('.editor-wrapper');
    expect(wrapper).not.toHaveAttribute('data-locked');
  });
});

// ── isDark / fontSize props ───────────────────────────────────────────────────
describe('Editor — isDark and fontSize props', () => {
  it('renders without error in light mode (isDark=false)', () => {
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} isDark={false} />,
    );
    expect(container.querySelector('.editor-wrapper')).toBeInTheDocument();
  });

  it('renders without error with a custom fontSize', () => {
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} fontSize={18} />,
    );
    expect(container.querySelector('.editor-wrapper')).toBeInTheDocument();
  });

  it('renders without error with fontSize=10 (small)', () => {
    const { container } = render(
      <Editor content="text" onChange={vi.fn()} fontSize={10} />,
    );
    expect(container.querySelector('.editor-wrapper')).toBeInTheDocument();
  });
});

// ── onAIMarkEdited wiring ─────────────────────────────────────────────────────
describe('Editor — onAIMarkEdited wiring', () => {
  it('renders without error when onAIMarkEdited is provided alongside aiMarks', () => {
    const onAIMarkEdited = vi.fn();
    const { container } = render(
      <Editor
        content="This is marked text"
        onChange={vi.fn()}
        aiMarks={[{ id: 'mark-1', text: 'marked text' }]}
        onAIMarkEdited={onAIMarkEdited}
      />,
    );
    expect(container.querySelector('.editor-wrapper')).toBeInTheDocument();
  });

  it('does not throw when aiMarks is updated via re-render', () => {
    const { rerender } = render(
      <Editor content="hello world" onChange={vi.fn()} aiMarks={[]} />,
    );
    expect(() =>
      rerender(
        <Editor
          content="hello world"
          onChange={vi.fn()}
          aiMarks={[{ id: 'mark-2', text: 'hello world' }]}
        />,
      ),
    ).not.toThrow();
  });
});
