/**
 * Shared MIME-type utilities — single source of truth for the whole codebase.
 *
 * Previously the extension→MIME map was copy-pasted in CanvasEditor (×3),
 * workspaceTools, AIPanel (×2), and MediaViewer.  Any additions (e.g. a new
 * image format) now only need to be made here.
 */

/** Mapping of lowercase file extension → MIME type for every media type the app handles. */
export const MIME_MAP: Record<string, string> = {
  // ── Images ──────────────────────────────────────────────────────────────────
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  avif: 'image/avif',
  bmp:  'image/bmp',
  ico:  'image/x-icon',
  tiff: 'image/tiff',
  tif:  'image/tiff',
  // ── Video ────────────────────────────────────────────────────────────────────
  mp4:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  m4v:  'video/mp4',
  mkv:  'video/x-matroska',
  ogv:  'video/ogg',
  avi:  'video/x-msvideo',
  // ── Audio ────────────────────────────────────────────────────────────────────
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  ogg:  'audio/ogg',
  aac:  'audio/aac',
  flac: 'audio/flac',
  m4a:  'audio/mp4',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  wma:  'audio/x-ms-wma',
};

/** All image extensions the app recognises. */
export const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tiff', 'tif',
]);

/**
 * Returns the MIME type for a given filename or bare extension.
 *
 * @param filename  Full filename (`"photo.jpg"`) or bare extension (`"jpg"`).
 * @param fallback  Value returned when the extension isn't recognised.
 *                  Defaults to `"application/octet-stream"`.
 *
 * @example
 *   getMimeType('photo.jpg')          // → 'image/jpeg'
 *   getMimeType('gif')                // → 'image/gif'
 *   getMimeType('unknown', 'image/png') // → 'image/png'
 */
export function getMimeType(filename: string, fallback = 'application/octet-stream'): string {
  const ext = filename.includes('.')
    ? (filename.split('.').pop()?.toLowerCase() ?? '')
    : filename.toLowerCase();
  return MIME_MAP[ext] ?? fallback;
}
