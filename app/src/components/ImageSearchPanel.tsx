/**
 * ImageSearchPanel — search stock photos from Pexels, preview 6 results,
 * click one to download it into the workspace images/ folder and optionally
 * place it on the active canvas.
 *
 * API key setup:
 *   Free at https://www.pexels.com/api/ — takes ~30 seconds.
 *   Key is stored in localStorage so you only enter it once.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Check, ArrowDown } from '@phosphor-icons/react';
import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Editor } from 'tldraw';
import type { Workspace } from '../types';
import './ImageSearchPanel.css';

// ── Pexels API types ─────────────────────────────────────────────────────────

interface PexelsPhoto {
  id: number;
  alt: string;
  photographer: string;
  photographer_url: string;
  url: string; // pexels page
  width: number;
  height: number;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
  avg_color: string;
}

interface PexelsResponse {
  total_results: number;
  photos: PexelsPhoto[];
  error?: string;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface ImageSearchPanelProps {
  workspace: Workspace;
  canvasEditorRef: React.RefObject<Editor | null>;
  onClose: () => void;
}

const LS_KEY = 'cafezin_pexels_key';
const PER_PAGE = 6;

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ImageSearchPanel({ workspace, canvasEditorRef, onClose }: ImageSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [keyInput, setKeyInput] = useState(() => localStorage.getItem(LS_KEY) ?? '');
  const [keyOpen, setKeyOpen] = useState(!localStorage.getItem(LS_KEY));
  const [results, setResults] = useState<PexelsPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null); // photo id being saved
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [addedToCanvas, setAddedToCanvas] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Dismiss on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function saveKey() {
    const k = keyInput.trim();
    localStorage.setItem(LS_KEY, k);
    setApiKey(k);
    setKeyOpen(false);
  }

  const search = useCallback(async (q: string) => {
    const key = apiKey.trim();
    if (!key) {
      setKeyOpen(true);
      setError('Paste your free Pexels API key first (takes 30 sec at pexels.com/api).');
      return;
    }
    if (!q.trim()) return;

    setLoading(true);
    setError(null);
    setResults([]);

    try {
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q.trim())}&per_page=${PER_PAGE}&orientation=landscape`;
      const res = await tauriFetch(url, {
        method: 'GET',
        headers: { Authorization: key },
      });
      if (!res.ok) {
        if (res.status === 401) {
          setError('Invalid API key — double-check your Pexels key below.');
          setKeyOpen(true);
        } else {
          setError(`Pexels returned ${res.status}. Try again in a moment.`);
        }
        return;
      }
      const data = await res.json() as PexelsResponse;
      if (data.error) { setError(data.error); return; }
      if (!data.photos?.length) {
        setError(`No results for "${q}". Try different keywords.`);
        return;
      }
      setResults(data.photos);
    } catch (e) {
      setError(`Search failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') search(query);
  }

  // Download the image and save to workspace/images/
  async function handleUse(photo: PexelsPhoto, addToCanvas: boolean) {
    setSaving(photo.id);
    try {
      // Ensure workspace/images/ folder exists
      const imagesDir = `${workspace.path}/images`;
      if (!(await exists(imagesDir))) {
        await mkdir(imagesDir, { recursive: true });
      }

      // Build filename: {id}-{alt-slug}.jpg
      const ext = photo.src.large.split('?')[0].split('.').pop() ?? 'jpg';
      const filename = `${photo.id}-${slugify(photo.alt || 'photo')}.${ext}`;
      const absPath = `${imagesDir}/${filename}`;

      // Download the 'large' size (~1880px) via Tauri HTTP plugin (bypasses CORS/CSP)
      const imgRes = await tauriFetch(photo.src.large, { method: 'GET' });
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
      const buf = await imgRes.arrayBuffer();
      await writeFile(absPath, new Uint8Array(buf));

      // Mark as saved
      setSaved((prev) => new Set(prev).add(photo.id));

      // Optional: place on canvas
      if (addToCanvas) {
        const editor = canvasEditorRef.current;
        if (editor) {
          const maxW = 800;
          const scale = Math.min(1, maxW / photo.width);
          const dispW = Math.round(photo.width * scale);
          const dispH = Math.round(photo.height * scale);
          const vp = editor.getViewportPageBounds();
          const placeX = Math.round(vp.x + vp.w / 2 - dispW / 2);
          const placeY = Math.round(vp.y + vp.h / 2 - dispH / 2);

          const assetId = `asset:img_${photo.id}` as ReturnType<typeof editor.getAssets>[0]['id'];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor.createAssets([{
            id: assetId,
            typeName: 'asset',
            type: 'image',
            props: {
              name: filename,
              // Use the image data URL isn't available, use the large URL — tldraw renders it in WebView
              src: photo.src.large,
              w: photo.width,
              h: photo.height,
              mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              isAnimated: false,
            },
            meta: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any]);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          editor.createShape({ type: 'image', x: placeX, y: placeY, props: { assetId, w: dispW, h: dispH } as any });
          setAddedToCanvas((prev) => new Set(prev).add(photo.id));
        }
      }
    } catch (e) {
      setError(`Failed to save image: ${e}`);
    } finally {
      setSaving(null);
    }
  }

  const hasCanvas = !!canvasEditorRef.current;

  return (
    <div className="isp-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="isp-panel">
        {/* Header */}
        <div className="isp-header">
          <span className="isp-title">🖼 Image Search</span>
          <span className="isp-source">via Pexels</span>
          <button className="isp-close" onClick={onClose} title="Close (Esc)"><X weight="thin" size={14} /></button>
        </div>

        {/* Search bar */}
        <div className="isp-search-row">
          <input
            ref={inputRef}
            className="isp-search-input"
            type="text"
            placeholder="e.g. mountain sunset, team collaboration, abstract blue…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="isp-search-btn"
            onClick={() => search(query)}
            disabled={loading || !query.trim()}
          >
            {loading ? '…' : 'Search'}
          </button>
        </div>

        {/* API key section */}
        <div className={`isp-key-section${keyOpen ? ' isp-key-section--open' : ''}`}>
          <button className="isp-key-toggle" onClick={() => setKeyOpen((v) => !v)}>
            <span className="isp-key-icon">⚙</span>
            <span>Pexels API Key</span>
            <span className={`isp-key-status${apiKey ? ' isp-key-status--ok' : ''}`}>
              {apiKey ? '●  set' : '○  not set'}
            </span>
            <span className="isp-key-chevron">{keyOpen ? '▴' : '▾'}</span>
          </button>
          {keyOpen && (
            <div className="isp-key-body">
              <p className="isp-key-hint">
                Free at{' '}
                <a href="https://www.pexels.com/api/" target="_blank" rel="noreferrer">
                  pexels.com/api
                </a>{' '}
                — sign up takes ~30 seconds.
              </p>
              <div className="isp-key-row">
                <input
                  className="isp-key-input"
                  type="password"
                  placeholder="Paste your Pexels API key…"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
                />
                <button className="isp-key-save" onClick={saveKey} disabled={!keyInput.trim()}>
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && <div className="isp-error">{error}</div>}

        {/* Loading skeleton */}
        {loading && (
          <div className="isp-grid">
            {Array.from({ length: PER_PAGE }).map((_, i) => (
              <div key={i} className="isp-skeleton" />
            ))}
          </div>
        )}

        {/* Results grid */}
        {!loading && results.length > 0 && (
          <>
            <div className="isp-grid">
              {results.map((photo) => {
                const isSaving = saving === photo.id;
                const isSaved = saved.has(photo.id);
                const isOnCanvas = addedToCanvas.has(photo.id);
                return (
                  <div
                    key={photo.id}
                    className={`isp-card${isSaved ? ' isp-card--saved' : ''}`}
                    style={{ backgroundColor: photo.avg_color }}
                  >
                    <img
                      className="isp-card-img"
                      src={photo.src.medium}
                      alt={photo.alt}
                      loading="lazy"
                    />
                    <div className="isp-card-overlay">
                      <div className="isp-card-credit">
                        Photo by <strong>{photo.photographer}</strong>
                      </div>
                      <div className="isp-card-actions">
                        {/* Save to workspace */}
                        <button
                          className="isp-card-btn isp-card-btn--save"
                          disabled={isSaving}
                          onClick={() => handleUse(photo, false)}
                          title="Save to workspace images/"
                        >
                          {isSaving ? '…' : isSaved ? <><Check weight="thin" size={13} /> Saved</> : <><ArrowDown weight="thin" size={13} /> Save</>}
                        </button>
                        {/* Add to canvas (only if a canvas is open) */}
                        {hasCanvas && (
                          <button
                            className="isp-card-btn isp-card-btn--canvas"
                            disabled={isSaving}
                            onClick={() => handleUse(photo, true)}
                            title="Save & add to active canvas"
                          >
                            {isOnCanvas ? <><Check weight="thin" size={13} /> On canvas</> : '+ Canvas'}
                          </button>
                        )}
                      </div>
                    </div>
                    {isSaved && !isOnCanvas && (
                      <div className="isp-card-badge"><Check weight="thin" size={12} /></div>
                    )}
                    {isOnCanvas && (
                      <div className="isp-card-badge isp-card-badge--canvas">◈</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="isp-attribution">
              Photos provided by{' '}
              <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
                Pexels
              </a>{' '}
              — free to use under the{' '}
              <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">
                Pexels License
              </a>
              . Images saved to <code>images/</code> in your workspace.
            </div>
          </>
        )}

        {/* Empty state */}
        {!loading && results.length === 0 && !error && (
          <div className="isp-empty">
            <div className="isp-empty-icon">🔍</div>
            <div className="isp-empty-text">
              Search for any topic — landscapes, business, technology, people…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
