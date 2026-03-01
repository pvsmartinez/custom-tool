-- Migration: 0002_user_secrets
-- Stores encrypted API secrets (Groq, Pexels, etc.) per authenticated user.
-- Values are AES-GCM encrypted on the client before upload — the server never
-- sees plaintext. RLS guarantees each user can only access their own rows.

CREATE TABLE IF NOT EXISTS public.user_secrets (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key        text        NOT NULL,
  value_enc  text        NOT NULL,   -- base64(AES-GCM-256 ciphertext)
  iv         text        NOT NULL,   -- base64(12-byte random IV)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE public.user_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own secrets only"
  ON public.user_secrets
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
