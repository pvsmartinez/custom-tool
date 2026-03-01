/**
 * useAuthSession — shared auth + synced-workspace state
 *
 * Used by both App.tsx (desktop) and MobileApp.tsx (iOS).
 * Handles:
 *   - Session bootstrap (getSession on mount)
 *   - OAuth deep-link callback (Tauri 'auth-callback' event)
 *   - OAuth busy state + 2-minute safety timeout
 *   - email/password signIn / signUp / signOut wrappers
 *   - Synced workspace list management
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  signIn, signUp, signOut, getSession,
  signInWithGoogle, signInWithApple,
  handleAuthCallbackUrl,
  listSyncedWorkspaces,
  type SyncedWorkspace,
} from '../services/syncConfig';

export interface UseAuthSessionOptions {
  /**
   * Called after a successful OAuth or email/password login.
   * Use this in App.tsx to run syncSecretsFromCloud() and dispatch
   * 'cafezin:auth-updated' without having to duplicate the callback listener.
   */
  onAuthSuccess?: () => void | Promise<void>;
}

export interface AuthSessionState {
  isLoggedIn: boolean;
  setIsLoggedIn: (v: boolean) => void;
  /** Currently in-progress OAuth provider, or null */
  oauthBusy: 'google' | 'apple' | null;
  /** email/password form action in progress */
  authBusy: boolean;
  authMode: 'login' | 'signup';
  setAuthMode: (m: 'login' | 'signup') => void;

  // ── Synced workspaces ──────────────────────────────────────────────────────
  syncedWorkspaces: SyncedWorkspace[];
  loadingSynced: boolean;
  syncError: string | null;
  loadSyncedList: () => Promise<void>;

  // ── Actions ────────────────────────────────────────────────────────────────
  /**
   * Sign in or sign up (depending on authMode) with email + password.
   * Returns an error string on failure, undefined on success.
   */
  handleAuth: (email: string, password: string) => Promise<string | undefined>;
  handleSignOut: () => Promise<void>;
  /** Initiates provider OAuth flow, opens browser, waits for deep-link callback. */
  handleOAuth: (provider: 'google' | 'apple') => Promise<string | undefined>;
}

export function useAuthSession(options?: UseAuthSessionOptions): AuthSessionState {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [oauthBusy, setOauthBusy] = useState<'google' | 'apple' | null>(null);

  const [syncedWorkspaces, setSyncedWorkspaces] = useState<SyncedWorkspace[]>([]);
  const [loadingSynced, setLoadingSynced] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const oauthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a stable ref to options so the auth-callback listener never becomes stale
  const onAuthSuccessRef = useRef(options?.onAuthSuccess);
  onAuthSuccessRef.current = options?.onAuthSuccess;

  // ── Session bootstrap ─────────────────────────────────────────────────────
  useEffect(() => {
    getSession()
      .then((session) => { if (session) setIsLoggedIn(true); })
      .catch(() => { /* not logged in */ });
  }, []);

  // ── OAuth deep-link callback (Tauri 'auth-callback') ──────────────────────
  // Registered once on mount; both App.tsx and MobileApp.tsx previously
  // duplicated this listener — the hook centralises it.
  useEffect(() => {
    const unlistenPromise = listen<string>('auth-callback', async (event) => {
      try {
        const user = await handleAuthCallbackUrl(event.payload);
        if (user) {
          setIsLoggedIn(true);
          setOauthBusy(null);
          if (oauthTimeoutRef.current) {
            clearTimeout(oauthTimeoutRef.current);
            oauthTimeoutRef.current = null;
          }
          await onAuthSuccessRef.current?.();
        }
      } catch (_err) {
        setOauthBusy(null);
        if (oauthTimeoutRef.current) {
          clearTimeout(oauthTimeoutRef.current);
          oauthTimeoutRef.current = null;
        }
      }
    });
    return () => { unlistenPromise.then((u) => u()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // register once on mount — refs track latest values without re-registering

  // ── Synced workspace list ─────────────────────────────────────────────────
  const loadSyncedList = useCallback(async () => {
    setLoadingSynced(true);
    setSyncError(null);
    try {
      const list = await listSyncedWorkspaces();
      setSyncedWorkspaces(list);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSynced(false);
    }
  }, []);

  // ── email/password auth ───────────────────────────────────────────────────
  const handleAuth = useCallback(async (email: string, password: string): Promise<string | undefined> => {
    if (!email || !password) return 'Informe e-mail e senha.';
    setAuthBusy(true);
    try {
      if (authMode === 'login') {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
      setIsLoggedIn(true);
      await onAuthSuccessRef.current?.();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setAuthBusy(false);
    }
  }, [authMode]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    setIsLoggedIn(false);
    setSyncedWorkspaces([]);
  }, []);

  // ── OAuth provider flow ────────────────────────────────────────────────────
  const handleOAuth = useCallback(async (provider: 'google' | 'apple'): Promise<string | undefined> => {
    setOauthBusy(provider);
    // Safety timeout: if the deep-link callback never fires, reset after 2 min
    if (oauthTimeoutRef.current) clearTimeout(oauthTimeoutRef.current);
    oauthTimeoutRef.current = setTimeout(() => {
      setOauthBusy(null);
      oauthTimeoutRef.current = null;
    }, 120_000);
    try {
      const url = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
      await openUrl(url);
      // oauthBusy stays set until the 'auth-callback' listener resolves it
      return undefined;
    } catch (err) {
      if (oauthTimeoutRef.current) {
        clearTimeout(oauthTimeoutRef.current);
        oauthTimeoutRef.current = null;
      }
      setOauthBusy(null);
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  return {
    isLoggedIn,
    setIsLoggedIn,
    oauthBusy,
    authBusy,
    authMode,
    setAuthMode,
    syncedWorkspaces,
    loadingSynced,
    syncError,
    loadSyncedList,
    handleAuth,
    handleSignOut,
    handleOAuth,
  };
}
