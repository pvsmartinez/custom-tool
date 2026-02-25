import { describe, it, expect } from 'vitest';
import { getFileTypeInfo } from '../utils/fileType';

// ── Markdown ─────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — markdown', () => {
  it('identifies .md files', () => {
    const info = getFileTypeInfo('notes.md');
    expect(info.kind).toBe('markdown');
    expect(info.supportsPreview).toBe(true);
    expect(info.defaultMode).toBe('edit');
    expect(info.language).toBe('markdown');
  });

  it('identifies .mdx files', () => {
    const info = getFileTypeInfo('page.mdx');
    expect(info.kind).toBe('markdown');
    expect(info.supportsPreview).toBe(true);
  });
});

// ── Canvas ────────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — canvas', () => {
  it('identifies .tldr.json files', () => {
    const info = getFileTypeInfo('board.tldr.json');
    expect(info.kind).toBe('canvas');
    expect(info.supportsPreview).toBe(false);
    expect(info.defaultMode).toBe('edit');
  });

  it('does NOT classify a plain .json file as canvas', () => {
    expect(getFileTypeInfo('data.json').kind).toBe('code');
  });
});

// ── PDF ───────────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — pdf', () => {
  it('identifies .pdf files', () => {
    const info = getFileTypeInfo('document.pdf');
    expect(info.kind).toBe('pdf');
    expect(info.defaultMode).toBe('preview');
    expect(info.supportsPreview).toBe(false);
  });
});

// ── Video ─────────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — video', () => {
  const videoFiles = ['clip.mp4', 'movie.webm', 'video.mov', 'film.m4v', 'sample.mkv', 'old.avi', 'archive.ogv'];
  videoFiles.forEach((name) => {
    it(`identifies ${name}`, () => {
      const info = getFileTypeInfo(name);
      expect(info.kind).toBe('video');
      expect(info.defaultMode).toBe('preview');
      expect(info.supportsPreview).toBe(false);
    });
  });
});

// ── Audio ─────────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — audio', () => {
  const audioFiles = ['song.mp3', 'sound.wav', 'audio.ogg', 'podcast.aac', 'music.flac', 'track.m4a'];
  audioFiles.forEach((name) => {
    it(`identifies ${name}`, () => {
      const info = getFileTypeInfo(name);
      expect(info.kind).toBe('audio');
      expect(info.defaultMode).toBe('preview');
      expect(info.supportsPreview).toBe(false);
    });
  });
});

// ── Image ─────────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — image', () => {
  const imageFiles = ['photo.png', 'pic.jpg', 'anim.gif', 'modern.webp', 'icon.ico', 'graphic.bmp'];
  imageFiles.forEach((name) => {
    it(`identifies ${name}`, () => {
      const info = getFileTypeInfo(name);
      expect(info.kind).toBe('image');
      expect(info.defaultMode).toBe('preview');
    });
  });
});

// ── Code files ────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — code', () => {
  const cases: [string, string, boolean][] = [
    // [filename, expected language, supportsPreview]
    ['index.ts',    'typescript',  false],
    ['app.tsx',     'typescript',  false],
    ['main.js',     'javascript',  false],
    ['comp.jsx',    'javascript',  false],
    ['style.css',   'css',         false],
    ['layout.scss', 'css',         false],
    ['index.html',  'html',        true],
    ['page.htm',    'html',        true],
    ['data.json',   'json',        false],
    ['server.py',   'python',      false],
    ['lib.rs',      'rust',        false],
    ['main.go',     'go',          false],
    ['hello.java',  'java',        false],
    ['config.yaml', 'yaml',        false],
    ['conf.yml',    'yaml',        false],
    ['query.sql',   'sql',         false],
    ['script.sh',   'shell',       false],
    ['config.toml', 'toml',        false],
    ['file.xml',    'xml',         false],
    ['Makefile.rb', 'ruby',        false],
    ['build.lua',   'lua',         false],
    ['code.cpp',    'cpp',         false],
    ['header.h',    'cpp',         false],
  ];

  cases.forEach(([filename, language, supportsPreview]) => {
    it(`${filename} → kind=code, language=${language}`, () => {
      const info = getFileTypeInfo(filename);
      expect(info.kind).toBe('code');
      expect(info.language).toBe(language);
      expect(info.defaultMode).toBe('edit');
      expect(info.supportsPreview).toBe(supportsPreview);
    });
  });
});

// ── Plain text / misc ─────────────────────────────────────────────────────────
describe('getFileTypeInfo — plain text', () => {
  it('identifies .txt files as code kind with empty language', () => {
    const info = getFileTypeInfo('readme.txt');
    expect(info.kind).toBe('code');
    expect(info.language).toBe('');
  });

  it('identifies .log files', () => {
    const info = getFileTypeInfo('app.log');
    expect(info.kind).toBe('code');
    expect(info.language).toBe('');
  });
});

// ── SVG: image, not code ──────────────────────────────────────────────────────
describe('getFileTypeInfo — svg', () => {
  it('classifies .svg as an image (not a code file)', () => {
    const info = getFileTypeInfo('icon.svg');
    expect(info.kind).toBe('image');
    expect(info.defaultMode).toBe('preview');
  });
});

// ── Unknown ───────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — unknown', () => {
  it('returns unknown for unrecognised extensions', () => {
    const info = getFileTypeInfo('archive.xyz');
    expect(info.kind).toBe('unknown');
    expect(info.supportsPreview).toBe(false);
    expect(info.defaultMode).toBe('edit');
  });

  it('returns unknown for files without an extension', () => {
    const info = getFileTypeInfo('Makefile');
    expect(info.kind).toBe('unknown');
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────
describe('getFileTypeInfo — edge cases', () => {
  it('is case-insensitive for extensions', () => {
    expect(getFileTypeInfo('Photo.PNG').kind).toBe('image');
    expect(getFileTypeInfo('Script.PY').kind).toBe('code');
    expect(getFileTypeInfo('Doc.MD').kind).toBe('markdown');
  });

  it('handles filenames with multiple dots correctly', () => {
    // The extension is determined by the last dot
    expect(getFileTypeInfo('my.notes.md').kind).toBe('markdown');
    expect(getFileTypeInfo('api.v2.json').kind).toBe('code');
  });
});
