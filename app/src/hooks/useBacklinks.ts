/**
 * useBacklinks — scans workspace markdown files for Zettelkasten-style links.
 *
 * Returns:
 *  backlinks  — files that link TO the current active file
 *  outlinks   — files that the active file links TO
 *
 * Patterns recognised:
 *   [text](filename.md)          standard relative link
 *   [text](./filename.md)
 *   [text](../dir/filename.md)
 *   [[filename]]                 wiki-style (extension optional)
 *   [[dir/filename]]
 */
import { useEffect, useRef, useState } from 'react';
import { readTextFile, exists } from '../services/fs';
import type { Workspace } from '../types';

export interface LinkRef {
  /** Workspace-relative path of the file */
  path: string;
  /** Display label (file name without extension) */
  label: string;
}

export interface BacklinksResult {
  backlinks: LinkRef[];
  outlinks: LinkRef[];
  loading: boolean;
}

/** Extract all markdown link targets from a piece of text */
function extractLinks(text: string, sourcePath: string): string[] {
  const targets: string[] = [];
  const sourceDir = sourcePath.includes('/')
    ? sourcePath.split('/').slice(0, -1).join('/')
    : '';

  // Standard markdown links: [text](target)
  const mdLinkRe = /\[([^\]]*)\]\(([^)#]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(text)) !== null) {
    const raw = m[2].trim();
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('#')) continue;
    // Resolve relative path
    const resolved = resolvePath(sourceDir, raw);
    if (resolved) targets.push(resolved);
  }

  // Wiki-style links: [[filename]] or [[dir/filename]]
  const wikiRe = /\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g;
  while ((m = wikiRe.exec(text)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    // Add .md extension if missing
    const withExt = raw.includes('.') ? raw : raw + '.md';
    const resolved = resolvePath(sourceDir, withExt);
    if (resolved) targets.push(resolved);
  }

  return [...new Set(targets)];
}

function resolvePath(fromDir: string, relativePath: string): string | null {
  if (!relativePath) return null;
  const parts = (fromDir ? fromDir + '/' + relativePath : relativePath).split('/');
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === '..') { resolved.pop(); }
    else if (p !== '.') resolved.push(p);
  }
  return resolved.join('/') || null;
}

function labelFromPath(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.(md|mdx|txt)$/i, '');
}

/** Get all markdown file paths from workspace (flat list) */
function collectMdFiles(workspace: Workspace): string[] {
  const result: string[] = [];
  function walk(nodes: typeof workspace.fileTree) {
    for (const n of nodes) {
      if (n.isDirectory && n.children) { walk(n.children); }
      else if (!n.isDirectory && /\.(md|mdx|txt)$/i.test(n.name)) {
        result.push(n.path);
      }
    }
  }
  walk(workspace.fileTree);
  return result;
}

export function useBacklinks(
  activeFile: string | null,
  workspace: Workspace | null,
  enabled = true,
): BacklinksResult {
  const [backlinks, setBacklinks] = useState<LinkRef[]>([]);
  const [outlinks, setOutlinks] = useState<LinkRef[]>([]);
  const [loading, setLoading] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!activeFile || !workspace || !enabled) {
      setBacklinks([]);
      setOutlinks([]);
      return;
    }

    // Only scan markdown files
    if (!/\.(md|mdx|txt)$/i.test(activeFile)) {
      setBacklinks([]);
      setOutlinks([]);
      return;
    }

    cancelRef.current = false;
    setLoading(true);

    const activeFilePath = activeFile; // narrowed: string (not null) — checked above
    const mdFiles = collectMdFiles(workspace);

    async function scan() {
      const foundBacklinks: LinkRef[] = [];
      const foundOutlinks: LinkRef[] = [];

      for (const filePath of mdFiles) {
        if (cancelRef.current) return;
        try {
          const absPath = `${workspace!.path}/${filePath}`;
          if (!(await exists(absPath))) continue;
          const text = await readTextFile(absPath);
          if (cancelRef.current) return;

          const links = extractLinks(text, filePath);

          if (filePath === activeFilePath) {
            // outlinks: what this file points to
            for (const target of links) {
              if (target !== activeFilePath) {
                foundOutlinks.push({ path: target, label: labelFromPath(target) });
              }
            }
          } else {
            // check if this file links to the active file
            if (links.includes(activeFilePath)) {
              foundBacklinks.push({ path: filePath, label: labelFromPath(filePath) });
            }
          }
        } catch {
          // file unreadable — skip
        }
      }

      if (!cancelRef.current) {
        setBacklinks(foundBacklinks);
        setOutlinks(foundOutlinks);
        setLoading(false);
      }
    }

    scan();
    return () => { cancelRef.current = true; };
  // Re-scan only when file or workspace tree changes (not on every keystroke)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, workspace?.path, workspace?.fileTree, enabled]);

  return { backlinks, outlinks, loading };
}
