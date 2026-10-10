-- ============================================================
-- 048_ai_pipeline_sync.sql — the AI assistant moves deals by itself
--
-- The account's prompt makes the assistant tag each conversation with a
-- stage label ([[ETIQUETA:nuevo_interesado]], area_definida,
-- datos_pago_enviados, pago_por_verificar) and [[ACCION:VERIFICAR_PAGO]].
-- With this enabled, every bot turn creates the contact's deal in the
-- chosen pipeline (if missing) and moves it forward to the matching
-- stage; deals whose customer has not written for `lost_after_days`
-- are moved to the "lost" stage. Stages outside the four mapped ones
-- (e.g. "purchase completed") are never touched — they stay manual.
--
-- `last_sweep_at` throttles the stale-deal sweep, which runs lazily
-- (on inbound messages and when the settings load) — no cron needed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_pipeline_sync (
  account_id           uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  pipeline_id          uuid REFERENCES pipelines(id) ON DELETE SET NULL,
  stage_new_id         uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_interested_id  uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_verify_id      uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_lost_id        uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  lost_after_days      integer NOT NULL DEFAULT 20
                         CHECK (lost_after_days BETWEEN 1 AND 365),
  last_sweep_at        timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_pipeline_sync ENABLE ROW LEVEL SECURITY;

-- Same shape as ai_configs / ai_pricing: members read, admin+ write;
-- the bot and the sweep run under the service role.
DROP POLICY IF EXISTS ai_pipeline_sync_select ON ai_pipeline_sync;
CREATE POLICY ai_pipeline_sync_select ON ai_pipeline_sync FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_pipeline_sync_insert ON ai_pipeline_sync;
CREATE POLICY ai_pipeline_sync_insert ON ai_pipeline_sync FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_pipeline_sync_update ON ai_pipeline_sync;
CREATE POLICY ai_pipeline_sync_update ON ai_pipeline_sync FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_pipeline_sync_delete ON ai_pipeline_sync;
CREATE POLICY ai_pipeline_sync_delete ON ai_pipeline_sync FOR DELETE
  USING (is_account_member(account_id, 'admin'));
