/** What kind of file this is — drives which viewer/editor is shown. */
export type FileKind = 'markdown' | 'pdf' | 'video' | 'image' | 'canvas' | 'code' | 'unknown';

export interface FileTypeInfo {
  kind: FileKind;
  /** Whether an Edit/Preview toggle makes sense for this file */
  supportsPreview: boolean;
  /** Which mode to default to when the file is first opened */
  defaultMode: 'edit' | 'preview';
  /** Language hint for CodeMirror (empty string = plain text) */
  language: string;
}

const CODE_EXTENSIONS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
  rs: 'rust',
  toml: 'toml',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  py: 'python',
  txt: '',
};

export function getFileTypeInfo(filename: string): FileTypeInfo {
  // .tldr.json must be checked before the generic `.json` extension path
  if (filename.endsWith('.tldr.json')) {
    return { kind: 'canvas', supportsPreview: false, defaultMode: 'edit', language: '' };
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'md' || ext === 'mdx') {
    return { kind: 'markdown', supportsPreview: true, defaultMode: 'edit', language: 'markdown' };
  }

  if (ext === 'pdf') {
    return { kind: 'pdf', supportsPreview: false, defaultMode: 'preview', language: '' };
  }

  // Videos — played via HTML5 <video>; macOS WebView supports mp4/webm/mov/m4v/mkv
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi'].includes(ext)) {
    return { kind: 'video', supportsPreview: false, defaultMode: 'preview', language: '' };
  }

  // Images + GIFs — shown via <img>
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'tif'].includes(ext)) {
    return { kind: 'image', supportsPreview: false, defaultMode: 'preview', language: '' };
  }

  if (ext in CODE_EXTENSIONS) {
    return { kind: 'code', supportsPreview: false, defaultMode: 'edit', language: CODE_EXTENSIONS[ext] };
  }

  // Slides etc. — treat as unknown, open read-only in editor
  return { kind: 'unknown', supportsPreview: false, defaultMode: 'edit', language: '' };
}
