import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  /** Unix ms when the access token expires */
  expires_at: number;
  email?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  mimeType: string;
}

export interface SlideOutline {
  title: string;
  bullets: string[];
}

// ── Token storage ─────────────────────────────────────────────────────────────

const TOKENS_KEY = 'custom-tool-google-tokens';

export function getStoredTokens(): GoogleTokens | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: GoogleTokens): void {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  localStorage.removeItem(TOKENS_KEY);
}

export function isGoogleConnected(): boolean {
  return getStoredTokens() !== null;
}

// ── OAuth2 PKCE ───────────────────────────────────────────────────────────────

/**
 * Full OAuth2 PKCE flow for a Google Desktop application credential.
 * The Rust `google_oauth` command handles: PKCE generation, local redirect
 * server, browser open, code capture.  We then exchange here.
 *
 * Requirements in .env:
 *   VITE_GOOGLE_CLIENT_ID     — OAuth2 client ID (Desktop app type)
 *   VITE_GOOGLE_CLIENT_SECRET — OAuth2 client secret (not really secret for Desktop apps)
 */
export async function startGoogleAuth(): Promise<GoogleTokens> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET as string | undefined;
  if (!clientId) throw new Error('VITE_GOOGLE_CLIENT_ID is not set in app/.env');

  // Rust handles PKCE + local server + browser open + code capture
  const result = await invoke<{ code: string; code_verifier: string; redirect_uri: string }>(
    'google_oauth',
    { clientId },
  );

  // Exchange authorization code for tokens
  const params = new URLSearchParams({
    code: result.code,
    client_id: clientId,
    client_secret: clientSecret ?? '',
    code_verifier: result.code_verifier,
    redirect_uri: result.redirect_uri,
    grant_type: 'authorization_code',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, string>;
    throw new Error(err.error_description ?? `Token exchange failed (${res.status})`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: GoogleTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  // Fetch email for display (non-fatal)
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (me.ok) {
      const info = await me.json() as { email?: string };
      tokens.email = info.email;
    }
  } catch { /* non-fatal */ }

  saveTokens(tokens);
  return tokens;
}

/** Returns a valid access token, refreshing if it's close to expiry. */
export async function getValidToken(): Promise<string> {
  const tokens = getStoredTokens();
  if (!tokens) throw new Error('Not connected to Google. Please connect first.');

  // Still valid for > 60 s — use it directly
  if (tokens.expires_at - Date.now() > 60_000) return tokens.access_token;

  // Refresh
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET as string ?? '';

  const params = new URLSearchParams({
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    clearTokens();
    throw new Error('Google session expired — please reconnect.');
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const updated: GoogleTokens = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(updated);
  return updated.access_token;
}

// ── Drive ─────────────────────────────────────────────────────────────────────

const DRIVE_FOLDER_NAME = 'custom-tool backups';

async function getOrCreateBackupFolder(token: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json() as { files: { id: string }[] };
  if (data.files?.length) return data.files[0].id;

  // Create the folder
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const folder = await createRes.json() as { id: string };
  return folder.id;
}

/** List all .md files backed up to Drive inside the app folder. */
export async function listDriveBackups(): Promise<DriveFile[]> {
  const token = await getValidToken();
  const folderId = await getOrCreateBackupFolder(token);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,mimeType)&orderBy=modifiedTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json() as { files: DriveFile[] };
  return data.files ?? [];
}

/** Upload (create or overwrite) a file to the backup folder. Returns the Drive file ID. */
export async function backupFileToDrive(filename: string, content: string): Promise<string> {
  const token = await getValidToken();
  const folderId = await getOrCreateBackupFolder(token);

  // Check if a file with the same name already exists in the folder
  const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const searchData = await searchRes.json() as { files: { id: string }[] };
  const existingId: string | undefined = searchData.files?.[0]?.id;

  const metadata = existingId
    ? { name: filename }
    : { name: filename, parents: [folderId] };

  const boundary = `boundary_ct_${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  const res = await fetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
  const file = await res.json() as { id: string };
  return file.id;
}

/** Download file content from Drive. */
export async function downloadFromDrive(fileId: string): Promise<string> {
  const token = await getValidToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  return res.text();
}

// ── Markdown → Slide outline ──────────────────────────────────────────────────

/**
 * Parse a Markdown document into a presentation title + per-slide outlines.
 *
 * Rules:
 *   # Title   → presentation title
 *   ## Slide  → new slide
 *   - bullet  → bullet on current slide
 *   plain text → also treated as a bullet
 */
export function markdownToSlideOutline(md: string): {
  presentationTitle: string;
  slides: SlideOutline[];
} {
  const lines = md.split('\n');
  let presentationTitle = 'Untitled Presentation';
  const slides: SlideOutline[] = [];
  let current: SlideOutline | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) {
      presentationTitle = line.slice(2).trim();
    } else if (line.startsWith('## ')) {
      if (current) slides.push(current);
      current = { title: line.slice(3).trim(), bullets: [] };
    } else if (current) {
      const text = line.startsWith('- ') || line.startsWith('* ')
        ? line.slice(2).trim()
        : line.startsWith('### ') ? line.slice(4).trim() : line;
      if (text && !text.startsWith('#')) current.bullets.push(text);
    }
  }
  if (current) slides.push(current);

  return { presentationTitle, slides };
}

// ── Google Slides ─────────────────────────────────────────────────────────────

export interface SlidesResult {
  presentationId: string;
  url: string;
  embedUrl: string;
}

/** Create a Google Slides presentation from the given outline. */
export async function createSlidesPresentation(
  title: string,
  slides: SlideOutline[],
): Promise<SlidesResult> {
  const token = await getValidToken();

  // 1. Create a blank presentation
  const createRes = await fetch('https://slides.googleapis.com/v1/presentations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Failed to create presentation (${createRes.status})`);
  }

  const presentation = await createRes.json() as {
    presentationId: string;
    slides?: Array<{ objectId: string }>;
  };
  const presentationId = presentation.presentationId;

  // 2. Build batchUpdate requests
  const requests: object[] = [];

  // Delete the default blank slide
  const defaultSlideId = presentation.slides?.[0]?.objectId;
  if (defaultSlideId) {
    requests.push({ deleteObject: { objectId: defaultSlideId } });
  }

  // One request group per slide
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const slideId  = `slide_${i}`;
    const titleId  = `title_${i}`;
    const bodyId   = `body_${i}`;

    requests.push({
      createSlide: {
        objectId: slideId,
        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: 'BODY',  index: 0 }, objectId: bodyId  },
        ],
      },
    });

    requests.push({
      insertText: { objectId: titleId, insertionIndex: 0, text: slide.title },
    });

    if (slide.bullets.length > 0) {
      requests.push({
        insertText: {
          objectId: bodyId,
          insertionIndex: 0,
          text: slide.bullets.join('\n'),
        },
      });
    }
  }

  // 3. Send batchUpdate
  if (requests.length > 0) {
    const batchRes = await fetch(
      `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      },
    );
    if (!batchRes.ok) {
      const err = await batchRes.json().catch(() => ({})) as { error?: { message?: string } };
      console.warn('Slides batchUpdate warning:', err.error?.message);
    }
  }

  return {
    presentationId,
    url:      `https://docs.google.com/presentation/d/${presentationId}/edit`,
    embedUrl: `https://docs.google.com/presentation/d/${presentationId}/embed?start=false&loop=false&delayms=3000`,
  };
}

/** Open a Google Slides presentation in the default browser. */
export async function openInBrowser(url: string): Promise<void> {
  await openUrl(url);
}
