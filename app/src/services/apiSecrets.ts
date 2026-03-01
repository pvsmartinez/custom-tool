/**
 * Encrypted API secrets — synced to Supabase per authenticated user.
 *
 * Security model:
 *  • Values are AES-GCM-256 encrypted by the client before upload.
 *    The Supabase DB only stores ciphertext — no plaintext ever leaves the device.
 *  • The encryption key is derived via PBKDF2 from the user's UUID +
 *    a fixed app salt — so a raw DB dump reveals nothing without the userId.
 *  • RLS (`own secrets only`) guarantees each row is inaccessible to other users.
 *  • localStorage is the primary read source (fast, works offline).
 *    Supabase is the sync layer: populate on login, push on every key save.
 *
 * Managed keys:
 *   cafezin-groq-key     — Groq API key (Whisper transcription + Groq models)
 *   cafezin_pexels_key   — Pexels API key (stock image search)
 */

import { supabase } from './supabase';

// ── Secrets catalogue ──────────────────────────────────────────────────────

export const SYNCED_SECRET_KEYS = [
  'cafezin-groq-key',
  'cafezin_pexels_key',
  'cafezin-vercel-token',
] as const;

export type SyncedSecretKey = typeof SYNCED_SECRET_KEYS[number];

// ── Crypto helpers ─────────────────────────────────────────────────────────

const APP_SALT = new TextEncoder().encode('cafezin-api-secrets-v1');

/**
 * Derive a 256-bit AES-GCM key from the user's UUID via PBKDF2.
 * The UUID is used as key material; real security comes from RLS + HTTPS.
 * This layer protects against raw database leaks.
 */
async function deriveKey(userId: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(userId),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: APP_SALT, iterations: 100_000, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptValue(
  plaintext: string,
  userId: string,
): Promise<{ enc: string; iv: string }> {
  const key = await deriveKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const toB64 = (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf)));
  return { enc: toB64(ciphertext), iv: toB64(iv) };
}

async function decryptValue(enc: string, iv: string, userId: string): Promise<string> {
  const key = await deriveKey(userId);
  const ciphertext = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
  const ivBytes    = Uint8Array.from(atob(iv),  (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Save an API secret to localStorage AND Supabase (if the user is logged in).
 * Always call this instead of `localStorage.setItem` for managed keys.
 *
 * Passing an empty string deletes the key from Supabase.
 */
export async function saveApiSecret(key: string, value: string): Promise<void> {
  // Persist locally first — instant, works offline
  if (value) {
    localStorage.setItem(key, value);
  } else {
    localStorage.removeItem(key);
  }

  // Sync to cloud in the background
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    if (!value) {
      await supabase
        .from('user_secrets')
        .delete()
        .eq('user_id', user.id)
        .eq('key', key);
      return;
    }

    const { enc, iv } = await encryptValue(value, user.id);
    await supabase.from('user_secrets').upsert(
      { user_id: user.id, key, value_enc: enc, iv, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,key' },
    );
  } catch {
    // Cloud sync failure is non-fatal — secret is already in localStorage
  }
}

/**
 * Pull all synced secrets from Supabase and populate localStorage.
 * Call once after login or on app startup when a session is already active.
 * Silently no-ops when unauthenticated or offline.
 *
 * Only writes to localStorage if the remote value is non-empty — never clears
 * a locally-set key that hasn't been uploaded yet.
 */
export async function syncSecretsFromCloud(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('user_secrets')
      .select('key, value_enc, iv')
      .eq('user_id', user.id)
      .in('key', SYNCED_SECRET_KEYS);

    if (error || !data) return;

    for (const row of data) {
      try {
        const plaintext = await decryptValue(row.value_enc, row.iv, user.id);
        if (plaintext) localStorage.setItem(row.key, plaintext);
      } catch {
        // Skip corrupted or mis-keyed rows silently
      }
    }
  } catch {
    // Network unavailable or unauthenticated — offline-first, no-op
  }
}
