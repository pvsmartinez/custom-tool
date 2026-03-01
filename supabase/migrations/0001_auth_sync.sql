-- Migration: 0001_auth_sync
-- Creates synced_workspaces table for Cafezin workspace sync via Supabase Auth.

CREATE TABLE IF NOT EXISTS public.synced_workspaces (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  git_url           text        NOT NULL,
  git_account_label text        NOT NULL DEFAULT 'personal',
  added_at          timestamptz NOT NULL DEFAULT now(),
  last_synced_at    timestamptz,
  UNIQUE (user_id, git_url)
);

ALTER TABLE public.synced_workspaces ENABLE ROW LEVEL SECURITY;

-- Users can only see and modify their own workspaces
CREATE POLICY "own workspaces only"
  ON public.synced_workspaces
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
