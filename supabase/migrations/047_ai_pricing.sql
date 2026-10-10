-- ============================================================
-- 047_ai_pricing.sql — exchange rate + price list for the AI assistant
--
-- Lets an account keep its prices in USD and have the assistant quote
-- them in bolívares at the official BCV rate of the day, without the
-- model ever doing arithmetic:
--
--   - `rate` / `rate_date` — Bs per USD in force today, refreshed
--     automatically from the BCV (fallback: DolarApi) when
--     `auto_update` is on, or typed by an admin when it is off.
--   - `next_rate` / `next_rate_date` — a rate the BCV already published
--     whose value date is still in the future (the BCV publishes the
--     next business day's rate in the afternoon). Shown, never used.
--   - `items` — `[{ "key": "P_PAQUETE", "label": "...", "usd": 50 }]`.
--     Each item becomes `{{KEY_BS}}`, `{{KEY_USD}}` and
--     `{{KEY_BS_COPIAR}}` variables that are substituted into the system
--     prompt and knowledge base right before every model call.
--
-- Also widens the per-conversation auto-reply cap: a sales conversation
-- (information → area → product → payment → receipt) easily exceeds 20
-- bot turns, after which the bot used to go silent for good.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_pricing (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  auto_update     boolean NOT NULL DEFAULT true,
  rate            numeric(18, 8) CHECK (rate IS NULL OR rate > 0),
  rate_date       date,
  rate_source     text CHECK (rate_source IS NULL OR rate_source IN ('bcv', 'dolarapi', 'manual')),
  next_rate       numeric(18, 8) CHECK (next_rate IS NULL OR next_rate > 0),
  next_rate_date  date,
  checked_at      timestamptz,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(items) = 'array'),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_pricing ENABLE ROW LEVEL SECURITY;

-- Same shape as ai_configs (migration 029): any member may read (the
-- settings page shows the rate), only admin+ may change it. The bot and
-- the automatic refresh run under the service role.
DROP POLICY IF EXISTS ai_pricing_select ON ai_pricing;
CREATE POLICY ai_pricing_select ON ai_pricing FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_pricing_insert ON ai_pricing;
CREATE POLICY ai_pricing_insert ON ai_pricing FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_pricing_update ON ai_pricing;
CREATE POLICY ai_pricing_update ON ai_pricing FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_pricing_delete ON ai_pricing;
CREATE POLICY ai_pricing_delete ON ai_pricing FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Wider auto-reply cap (was 1–20). The inline CHECK from 029 got
-- Postgres' default name.
-- ------------------------------------------------------------
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 500);
