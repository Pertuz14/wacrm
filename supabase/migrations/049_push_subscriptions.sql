-- ============================================================
-- 049_push_subscriptions.sql — Web Push notifications on every device
--
-- Each row is one browser/device (PC, phone, tablet) that turned on
-- notifications in Settings. When a customer message arrives, the
-- webhook sends a push to every device of the account's members, so the
-- alert arrives even with the app closed (phones need the app installed
-- on the home screen on iPhone/iPad).
--
-- Rows are written by /api/push/subscription (service role, after
-- checking the caller); members can read and delete only their own.
-- Dead subscriptions (the browser revoked them) are pruned on send.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx
  ON push_subscriptions (account_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select_own ON push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON push_subscriptions FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS push_subscriptions_delete_own ON push_subscriptions;
CREATE POLICY push_subscriptions_delete_own ON push_subscriptions FOR DELETE
  USING (user_id = auth.uid());
