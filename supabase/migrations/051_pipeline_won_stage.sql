-- ============================================================
-- 051_pipeline_won_stage.sql — closed sales land in "purchase completed"
--
-- When the store (e.g. the Rumbo a la U platform) registers a paid
-- access, it calls POST /api/v1/sales with the customer's phone, name
-- and amount. The contact's deal in the synced pipeline then moves to
-- this stage, marked won, with the sale's value in USD.
--
-- Optional: when null, a stage whose name looks like "Compra
-- finalizada" / "Ganado" / "Won" in the same pipeline is used.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_pipeline_sync
  ADD COLUMN IF NOT EXISTS stage_won_id uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL;
