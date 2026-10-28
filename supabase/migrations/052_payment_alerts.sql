-- ============================================================
-- 052_payment_alerts.sql — one-tap "enable access" from Telegram
--
-- Every "payment to verify" alert the assistant raises is stored here
-- with the customer's registration. The Telegram alert carries an
-- "✅ Habilitar acceso" button; when the owner taps it the alert moves
-- to `approved`, and the store (e.g. the Rumbo a la U platform) pulls
-- it with its own API key (scope sales:write) and registers the sale.
--
--   pending → approved (owner tapped) → processing (store claimed it)
--           → done (registered)  |  back to pending with `error`
--
-- Only the service role reads or writes it (RLS on, no policies).
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid,
  contact_id      uuid,
  phone           text,
  fields          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'processing', 'done')),
  -- The alert text as sent, and where (to edit it with the outcome)
  message_text    text,
  telegram        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ "chat_id": "...", "message_id": 123 }]
  summary         text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_alerts_account_idx ON payment_alerts (account_id, created_at DESC);

ALTER TABLE payment_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE payment_alerts FROM anon, authenticated;
GRANT ALL ON TABLE payment_alerts TO service_role;
