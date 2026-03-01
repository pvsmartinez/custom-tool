/**
 * useCanvasDrop — drag-and-drop image placement + workspace image browser.
 *
 * Owns: isDragOver, wsImages, wsImagesLoading
 * Provides: handleSidebarFileDrop, handleExternalFileDrop, handleAddImageFromUrl, loadWsImages
 * Side-effect: registers native capture-phase dragover/dragleave/drop on mainDivRef
 */
import { useState, useRef, useEffect } from 'react';
import type { Editor } from 'tldraw';
import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getMimeType, IMAGE_EXTS } from '../../../utils/mime';
import { walkFilesFlat } from '../../../services/workspace';
import { placeImageOnCanvas } from '../../../utils/canvasAI';

interface UseCanvasDropOptions {
  editorRef: React.MutableRefObject<Editor | null>;
  mainDivRef: React.MutableRefObject<HTMLDivElement | null>;
  workspacePath: string;
  onFileSaved?: () => void;
}

export function useCanvasDrop({
  editorRef, mainDivRef, workspacePath, onFileSaved,
}: UseCanvasDropOptions) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [wsImages, setWsImages] = useState<string[]>([]);
  const [wsImagesLoading, setWsImagesLoading] = useState(false);

  // Stable refs so the capture-phase listeners always call the latest closures.
  const nativeDropRef = useRef<{
    sidebar: (relPath: string, cx: number, cy: number) => void;
    external: (files: FileList, cx: number, cy: number) => void;
  }>({ sidebar: () => {}, external: () => {} });

  function slugFile(name: string) {
    return name.replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-').toLowerCase();
  }

  async function handleAddImageFromUrl(rawUrl: string) {
    const editor = editorRef.current;
    if (!editor || !rawUrl.trim()) return;
    const url = rawUrl.trim();
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? 'png';
    const mimeType = getMimeType(ext, 'image/png');
    let natW = 800, natH = 600;
    try {
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => { natW = img.naturalWidth || 800; natH = img.naturalHeight || 600; resolve(); };
        img.onerror = () => resolve();
        img.src = url;
      });
    } catch { /* use defaults */ }
    placeImageOnCanvas(editor, url, url.split('/').pop()?.split('?')[0] ?? 'image', mimeType, natW, natH);
  }

  async function handleExternalFileDrop(files: FileList, dropClientX: number, dropClientY: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const rect = mainDivRef.current?.getBoundingClientRect();
    const screenX = dropClientX - (rect?.left ?? 0);
    const screenY = dropClientY - (rect?.top ?? 0);
    const pagePos = editor.screenToPage({ x: screenX, y: screenY });
    let offsetX = 0;
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
      if (!IMAGE_EXTS.has(ext)) continue;
      const mimeType = getMimeType(ext, 'image/png');
      const imagesDir = `${workspacePath}/images`;
      if (!(await exists(imagesDir))) await mkdir(imagesDir, { recursive: true });
      const filename = slugFile(file.name);
      const absPath = `${imagesDir}/${filename}`;
      const buf = await file.arrayBuffer();
      await writeFile(absPath, new Uint8Array(buf));
      const objUrl = URL.createObjectURL(file);
      const { natW, natH } = await new Promise<{ natW: number; natH: number }>((resolve) => {
        const img = new Image();
        img.onload = () => { resolve({ natW: img.naturalWidth || 800, natH: img.naturalHeight || 600 }); URL.revokeObjectURL(objUrl); };
        img.onerror = () => { resolve({ natW: 800, natH: 600 }); URL.revokeObjectURL(objUrl); };
        img.src = objUrl;
      });
      const src = convertFileSrc(absPath);
      placeImageOnCanvas(editor, src, filename, mimeType, natW, natH, { dropX: pagePos.x + offsetX, dropY: pagePos.y });
      offsetX += Math.round(Math.min(natW, 800) + 20);
    }
    loadWsImages();
    onFileSaved?.();
  }

  async function handleSidebarFileDrop(relPath: string, dropClientX: number, dropClientY: number) {
    const editor = editorRef.current;
    if (!editor) return;
    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    if (!IMAGE_EXTS.has(ext)) return;
    const mimeType = getMimeType(ext, 'image/png');
    const absPath = `${workspacePath}/${relPath}`;
    const src = convertFileSrc(absPath);
    const { natW, natH } = await new Promise<{ natW: number; natH: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ natW: img.naturalWidth || 800, natH: img.naturalHeight || 600 });
      img.onerror = () => resolve({ natW: 800, natH: 600 });
      img.src = src;
    });
    const rect = mainDivRef.current?.getBoundingClientRect();
    const screenX = dropClientX - (rect?.left ?? 0);
    const screenY = dropClientY - (rect?.top ?? 0);
    const pagePos = editor.screenToPage({ x: screenX, y: screenY });
    placeImageOnCanvas(editor, src, relPath.split('/').pop() ?? relPath, mimeType, natW, natH, {
      dropX: pagePos.x, dropY: pagePos.y,
    });
  }

  // Keep native ref in sync with latest closures.
  nativeDropRef.current.sidebar = handleSidebarFileDrop;
  nativeDropRef.current.external = handleExternalFileDrop;

  async function loadWsImages() {
    setWsImagesLoading(true);
    try {
      const WS_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
      const images = await walkFilesFlat(workspacePath, '', (_, ext) => WS_IMG_EXTS.has(ext));
      setWsImages(images);
    } catch {
      setWsImages([]);
    } finally {
      setWsImagesLoading(false);
    }
  }

  // ── Native capture-phase drag listeners (intercept before tldraw) ──────────
  useEffect(() => {
    const el = mainDivRef.current;
    if (!el) return;

    function onDragOver(e: DragEvent) {
      const hasWsFile = e.dataTransfer?.types.includes('text/x-workspace-file');
      const hasFiles  = e.dataTransfer?.types.includes('Files');
      if (!hasWsFile && !hasFiles) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    }
    function onDragLeave(e: DragEvent) {
      if (!(el as HTMLDivElement).contains(e.relatedTarget as Node)) setIsDragOver(false);
    }
    function onDrop(e: DragEvent) {
      const hasWsFile = e.dataTransfer?.types.includes('text/x-workspace-file');
      const hasFiles  = e.dataTransfer?.files && e.dataTransfer.files.length > 0;
      if (!hasWsFile && !hasFiles) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const wsFile = e.dataTransfer?.getData('text/x-workspace-file');
      if (wsFile) { nativeDropRef.current.sidebar(wsFile, e.clientX, e.clientY); return; }
      if (e.dataTransfer?.files.length) {
        nativeDropRef.current.external(e.dataTransfer.files, e.clientX, e.clientY);
      }
    }

    el.addEventListener('dragover',  onDragOver,  true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop',      onDrop,      true);
    return () => {
      el.removeEventListener('dragover',  onDragOver,  true);
      el.removeEventListener('dragleave', onDragLeave, true);
      el.removeEventListener('drop',      onDrop,      true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isDragOver,
    wsImages,
    wsImagesLoading,
    loadWsImages,
    handleSidebarFileDrop,
    handleExternalFileDrop,
    handleAddImageFromUrl,
  };
}
