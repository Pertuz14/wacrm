-- ============================================================
-- 070_performance_and_sweep.sql — faster lookups, one-query sweep,
-- and the "closed at" stamp for cards dragged to "Muerto"
--
--   1. Indexes for the queries every bot turn and webhook run:
--      a contact's cards, a conversation's customer messages, a card's
--      stage history.
--   2. sweep_stale_deals(account): moves every card whose customer has
--      been silent for `lost_after_days` to its pipeline's lost stage in
--      ONE statement (the app did 1–2 queries per card). Same rules as
--      before: only open cards in the automatic stages (new, interested,
--      verify) of the synced pipelines, created before the cutoff, and
--      whose last customer message (any conversation) is older too.
--      sweep_all_stale_deals() runs it for every account with the sync on
--      — what the hourly job in 071 calls.
--   3. Trigger order: 058 aligns status with the stage in a BEFORE
--      trigger; 069's "closed at" stamp ran before it (triggers fire in
--      name order) and only on "UPDATE OF status", so a card dragged to
--      "Muerto" never got a closing date. The alignment now runs first
--      and the stamp looks at every update.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Indexes ---------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_deals_contact_pipeline
  ON deals(contact_id, pipeline_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sender_created
  ON messages(conversation_id, sender_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal
  ON deal_stage_events(deal_id, created_at DESC);

-- 2. One-query sweep -------------------------------------------
CREATE OR REPLACE FUNCTION sweep_stale_deals(p_account uuid, p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days  integer;
  v_moved integer := 0;
BEGIN
  SELECT lost_after_days INTO v_days
  FROM ai_pipeline_sync
  WHERE account_id = p_account AND enabled;
  IF v_days IS NULL THEN
    RETURN 0;
  END IF;

  WITH synced AS (
    SELECT pipeline_id, stage_new_id, stage_interested_id, stage_verify_id, stage_lost_id
    FROM ai_pipeline_sync WHERE account_id = p_account
    UNION ALL
    SELECT pipeline_id, stage_new_id, stage_interested_id, stage_verify_id, stage_lost_id
    FROM ai_pipeline_programs WHERE account_id = p_account
  ),
  stale AS (
    SELECT d.id, s.stage_lost_id
    FROM deals d
    JOIN synced s ON s.pipeline_id = d.pipeline_id
    WHERE d.account_id = p_account
      AND d.status = 'open'
      AND s.stage_lost_id IS NOT NULL
      AND d.stage_id IN (s.stage_new_id, s.stage_interested_id, s.stage_verify_id)
      AND d.created_at < p_now - make_interval(days => v_days)
      AND NOT EXISTS (
        SELECT 1
        FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        WHERE c.contact_id = d.contact_id
          AND c.account_id = p_account
          AND m.sender_type = 'customer'
          AND m.created_at >= p_now - make_interval(days => v_days)
      )
  )
  UPDATE deals d
  SET stage_id = stale.stage_lost_id, status = 'lost', updated_at = p_now
  FROM stale
  WHERE d.id = stale.id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  UPDATE ai_pipeline_sync SET last_sweep_at = p_now WHERE account_id = p_account;
  RETURN v_moved;
END;
$$;

CREATE OR REPLACE FUNCTION sweep_all_stale_deals()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_total integer := 0;
BEGIN
  FOR r IN SELECT account_id FROM ai_pipeline_sync WHERE enabled LOOP
    v_total := v_total + sweep_stale_deals(r.account_id);
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION sweep_stale_deals(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sweep_all_stale_deals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sweep_stale_deals(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION sweep_all_stale_deals() TO service_role;

-- 3. Trigger order ---------------------------------------------
DROP TRIGGER IF EXISTS deals_status_stage ON deals;
DROP TRIGGER IF EXISTS deals_align_status_stage ON deals;
CREATE TRIGGER deals_align_status_stage            -- "align" < "stamp": runs first
  BEFORE UPDATE OF stage_id, status ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_deals_status_stage();

DO $$
BEGIN
  IF to_regprocedure('public.stamp_deal_closed_at()') IS NOT NULL THEN
    -- Cards already lost/won without a closing date (e.g. dragged to
    -- "Muerto" before this fix): use their last update. Done before the
    -- stamp listens to every update, so it keeps these dates.
    UPDATE deals SET closed_at = COALESCE(updated_at, created_at)
    WHERE status IN ('won', 'lost') AND closed_at IS NULL;
    DROP TRIGGER IF EXISTS deals_stamp_closed_at ON deals;
    CREATE TRIGGER deals_stamp_closed_at
      BEFORE INSERT OR UPDATE ON deals
      FOR EACH ROW EXECUTE FUNCTION public.stamp_deal_closed_at();
  END IF;
END;
$$;
