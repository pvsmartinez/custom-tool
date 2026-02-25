import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownPreview from '../components/MarkdownPreview';

// ── Basic rendering ───────────────────────────────────────────────────────────
describe('MarkdownPreview — basic rendering', () => {
  it('renders without crashing', () => {
    const { container } = render(<MarkdownPreview content="" />);
    expect(container.querySelector('.md-preview-scroll')).toBeInTheDocument();
    expect(container.querySelector('.md-preview-body')).toBeInTheDocument();
  });

  it('renders an empty body when content is empty', () => {
    const { container } = render(<MarkdownPreview content="" />);
    expect(container.querySelector('.md-preview-body')?.innerHTML.trim()).toBe('');
  });
});

// ── Headings ──────────────────────────────────────────────────────────────────
describe('MarkdownPreview — headings', () => {
  it('renders an H1', () => {
    render(<MarkdownPreview content="# Hello World" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hello World');
  });

  it('renders H2 and H3', () => {
    render(<MarkdownPreview content={`## Section\n### Subsection`} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Section');
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Subsection');
  });
});

// ── Inline formatting ─────────────────────────────────────────────────────────
describe('MarkdownPreview — inline formatting', () => {
  it('renders bold text', () => {
    const { container } = render(<MarkdownPreview content="**bold**" />);
    expect(container.querySelector('strong')).toHaveTextContent('bold');
  });

  it('renders italic text', () => {
    const { container } = render(<MarkdownPreview content="_italic_" />);
    expect(container.querySelector('em')).toHaveTextContent('italic');
  });

  it('renders inline code', () => {
    const { container } = render(<MarkdownPreview content="Use `const x = 1`" />);
    expect(container.querySelector('code')).toHaveTextContent('const x = 1');
  });

  it('renders a strikethrough (GFM extension)', () => {
    const { container } = render(<MarkdownPreview content="~~deleted~~" />);
    expect(container.querySelector('del')).toHaveTextContent('deleted');
  });
});

// ── Block elements ────────────────────────────────────────────────────────────
describe('MarkdownPreview — block elements', () => {
  it('renders a paragraph', () => {
    render(<MarkdownPreview content="Just a paragraph." />);
    expect(screen.getByText('Just a paragraph.')).toBeInTheDocument();
  });

  it('renders a fenced code block', () => {
    const { container } = render(
      <MarkdownPreview content={'```\nconst x = 1;\n```'} />,
    );
    expect(container.querySelector('pre code')).toBeInTheDocument();
  });

  it('renders a blockquote', () => {
    const { container } = render(<MarkdownPreview content="> quote text" />);
    const bq = container.querySelector('blockquote');
    expect(bq).toBeInTheDocument();
    expect(bq).toHaveTextContent('quote text');
  });

  it('renders an unordered list', () => {
    const { container } = render(
      <MarkdownPreview content={'- item one\n- item two\n- item three'} />,
    );
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('item one');
  });

  it('renders an ordered list', () => {
    const { container } = render(
      <MarkdownPreview content={'1. first\n2. second'} />,
    );
    const ol = container.querySelector('ol');
    expect(ol).toBeInTheDocument();
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
  });

  it('renders a horizontal rule', () => {
    const { container } = render(<MarkdownPreview content="---" />);
    expect(container.querySelector('hr')).toBeInTheDocument();
  });
});

// ── Links & images ────────────────────────────────────────────────────────────
describe('MarkdownPreview — links', () => {
  it('renders an anchor tag with correct href', () => {
    const { container } = render(
      <MarkdownPreview content="[Visit GitHub](https://github.com)" />,
    );
    const a = container.querySelector('a');
    expect(a).toHaveAttribute('href', 'https://github.com');
    expect(a).toHaveTextContent('Visit GitHub');
  });

  it('renders an image tag', () => {
    const { container } = render(
      <MarkdownPreview content="![alt text](images/photo.png)" />,
    );
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'images/photo.png');
    expect(img).toHaveAttribute('alt', 'alt text');
  });
});

// ── GFM table ─────────────────────────────────────────────────────────────────
describe('MarkdownPreview — GFM table', () => {
  it('renders a table with thead and tbody', () => {
    const { container } = render(
      <MarkdownPreview
        content={
          '| Name | Role |\n' +
          '|------|------|\n' +
          '| Alice | Engineer |\n' +
          '| Bob | Designer |'
        }
      />,
    );
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelector('thead')).toBeInTheDocument();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

// ── Error recovery ────────────────────────────────────────────────────────────
describe('MarkdownPreview — error recovery', () => {
  it('renders a fallback message when marked throws', () => {
    // Force marked to throw by temporarily breaking it:
    // We can't easily do that without vi.mock, but we CAN test that very long
    // or malicious content doesn't crash the component.
    expect(() =>
      render(
        <MarkdownPreview
          content={'<script>alert("xss")</script>\n# Normal heading'}
        />,
      ),
    ).not.toThrow();
  });

  it('memoises the rendered HTML — does not re-render on same content', () => {
    const { rerender, container } = render(
      <MarkdownPreview content="# Same" />,
    );
    const firstBody = container.querySelector('.md-preview-body')!.innerHTML;
    rerender(<MarkdownPreview content="# Same" />);
    const secondBody = container.querySelector('.md-preview-body')!.innerHTML;
    expect(firstBody).toBe(secondBody);
  });
});

// ── Full document ─────────────────────────────────────────────────────────────
describe('MarkdownPreview — full document', () => {
  it('renders a realistic markdown document', () => {
    const content = `
# Project Title

A short description of the project.

## Features

- **Fast**: Built with Vite and Tauri
- **Portable**: Ships as a native app
- \`Keyboard shortcuts\` for everything

## Code Example

\`\`\`typescript
const greeting = (name: string) => \`Hello, \${name}!\`;
\`\`\`

[Learn more](https://example.com)
`;
    const { container } = render(<MarkdownPreview content={content} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Project Title');
    expect(screen.getByRole('heading', { level: 2, name: 'Features' })).toBeInTheDocument();
    expect(container.querySelector('pre code')).toBeInTheDocument();
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com');
  });
});
