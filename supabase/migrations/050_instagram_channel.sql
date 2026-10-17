-- ============================================================
-- 050_instagram_channel.sql — Instagram Direct as a second inbox channel
--
-- Instagram DMs land in the same inbox as WhatsApp. Each conversation
-- now carries the channel it belongs to; the send paths read it to
-- route a reply through the Instagram Messaging API instead of
-- WhatsApp Cloud API.
--
--   * conversations.channel — 'whatsapp' (every existing row) or
--     'instagram'.
--   * contacts.ig_user_id — Instagram-scoped user ID (IGSID) of the
--     customer. Unique per account; the inbound lookup key for
--     Instagram, the way wa_user_id is for WhatsApp (migration 040).
--     Instagram contacts have no phone, so `phone` is stored as ''
--     (tolerated by 022's partial unique index).
--   * contacts.ig_username — display only (users can change it).
--   * instagram_config — one connected Instagram professional account
--     per CRM account: token (encrypted), app secret (encrypted, to
--     verify webhook signatures), verify token, and the
--     comment-to-DM ("comment GUIA and get a DM") settings.
--   * instagram_comment_replies — one row per comment we already
--     answered, so a webhook replay never DMs the same person twice.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('whatsapp', 'instagram'));
  END IF;
END $$;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ig_user_id TEXT,
  ADD COLUMN IF NOT EXISTS ig_username TEXT;

COMMENT ON COLUMN contacts.ig_user_id IS
  'Instagram-scoped user ID (IGSID) of a customer who wrote by Instagram Direct. Unique per account; the inbound lookup key for Instagram.';
COMMENT ON COLUMN contacts.ig_username IS
  'Instagram username without the leading @. Display only — never an identity key.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_ig_user_id
  ON contacts (account_id, ig_user_id)
  WHERE ig_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- instagram_config
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instagram_config (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Instagram professional account ID (the `entry.id` of webhooks)
  ig_account_id         text NOT NULL,
  username              text,
  access_token          text NOT NULL,          -- encrypted (lib/whatsapp/encryption)
  app_secret            text,                   -- encrypted; verifies x-hub-signature-256
  verify_token          text NOT NULL,          -- encrypted; webhook GET handshake
  token_refreshed_at    timestamptz,
  token_expires_at      timestamptz,
  status                text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  -- Short note appended to the AI prompt for Instagram conversations
  ai_channel_note       text,
  -- Comment → DM
  comment_reply_enabled boolean NOT NULL DEFAULT false,
  comment_keywords      text[] NOT NULL DEFAULT '{}',
  comment_reply_text    text,
  comment_public_reply  text,
  connected_at          timestamptz DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_config_ig_account
  ON instagram_config (ig_account_id);

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instagram_config_select ON instagram_config;
DROP POLICY IF EXISTS instagram_config_insert ON instagram_config;
DROP POLICY IF EXISTS instagram_config_update ON instagram_config;
DROP POLICY IF EXISTS instagram_config_delete ON instagram_config;
CREATE POLICY instagram_config_select ON instagram_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY instagram_config_insert ON instagram_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_config_update ON instagram_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_config_delete ON instagram_config FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON instagram_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- instagram_comment_replies — idempotency for comment → DM
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instagram_comment_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  comment_id  text NOT NULL,
  media_id    text,
  from_id     text,
  keyword     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, comment_id)
);

ALTER TABLE instagram_comment_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instagram_comment_replies_select ON instagram_comment_replies;
CREATE POLICY instagram_comment_replies_select ON instagram_comment_replies
  FOR SELECT USING (is_account_member(account_id));
-- Writes come only from the webhook (service role bypasses RLS).
