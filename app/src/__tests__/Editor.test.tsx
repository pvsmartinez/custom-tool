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
