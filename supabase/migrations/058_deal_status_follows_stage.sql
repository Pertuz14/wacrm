-- ============================================================
-- 058_deal_status_follows_stage.sql — "lost" and the "Muerto" stage
-- are the same thing
--
-- A deal could be lost in two inconsistent ways: "Mark as lost" set
-- status = 'lost' but left the card in its stage (so its tag never
-- became "Muerto"), and dragging a card to "Muerto" moved it but left
-- status = 'open'. Now, on every update:
--
--   * stage changed (and status not)  → status follows the stage:
--       lost stage → 'lost', won stage → 'won', any other → 'open'
--   * status changed (and stage not)  → the card moves:
--       'lost' → the pipeline's lost stage ("Muerto")
--       'won'  → the pipeline's won stage ("Compra finalizada")
--       'open' from the lost/won stage → back to the last stage it was
--       in before (stage history), else the first stage
--   * both changed (the AI sync, the 20-day sweep, closed sales) →
--     left as given.
--
-- The stage tags then follow as always (053). Existing mismatches are
-- fixed once at the end.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- The pipeline's lost / won stage: the AI sync settings first, else a
-- stage whose name reads like it.
CREATE OR REPLACE FUNCTION pipeline_lost_stage(p_pipeline uuid)
RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT stage_lost_id FROM ai_pipeline_sync WHERE pipeline_id = p_pipeline AND stage_lost_id IS NOT NULL LIMIT 1),
    (SELECT stage_lost_id FROM ai_pipeline_programs WHERE pipeline_id = p_pipeline AND stage_lost_id IS NOT NULL LIMIT 1),
    (SELECT id FROM pipeline_stages WHERE pipeline_id = p_pipeline
       AND name ~* '(muert|perdid|\mlost\M)' ORDER BY position LIMIT 1)
  )
$$;

CREATE OR REPLACE FUNCTION pipeline_won_stage(p_pipeline uuid)
RETURNS uuid
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT stage_won_id FROM ai_pipeline_sync WHERE pipeline_id = p_pipeline AND stage_won_id IS NOT NULL LIMIT 1),
    (SELECT stage_won_id FROM ai_pipeline_programs WHERE pipeline_id = p_pipeline AND stage_won_id IS NOT NULL LIMIT 1),
    (SELECT id FROM pipeline_stages WHERE pipeline_id = p_pipeline
       AND name ~* '(compra\s+finalizada|finalizad|ganad|\mwon\M)' ORDER BY position LIMIT 1)
  )
$$;

-- Status a stage implies (replaces 057's version: same answers, plus
-- stages named like "Muerto" in pipelines without AI sync settings).
CREATE OR REPLACE FUNCTION stage_deal_status(p_stage uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_stage = pipeline_lost_stage(s.pipeline_id) THEN 'lost'
    WHEN p_stage = pipeline_won_stage(s.pipeline_id) THEN 'won'
    ELSE 'open'
  END
  FROM pipeline_stages s
  WHERE s.id = p_stage
$$;

CREATE OR REPLACE FUNCTION trg_deals_status_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage_changed  boolean := NEW.stage_id IS DISTINCT FROM OLD.stage_id;
  v_status_changed boolean := NEW.status IS DISTINCT FROM OLD.status;
  v_lost uuid;
  v_won  uuid;
  v_back uuid;
BEGIN
  IF v_stage_changed AND NOT v_status_changed THEN
    NEW.status := COALESCE(stage_deal_status(NEW.stage_id), NEW.status);
  ELSIF v_status_changed AND NOT v_stage_changed THEN
    v_lost := pipeline_lost_stage(NEW.pipeline_id);
    v_won  := pipeline_won_stage(NEW.pipeline_id);
    IF NEW.status = 'lost' AND v_lost IS NOT NULL THEN
      NEW.stage_id := v_lost;
    ELSIF NEW.status = 'won' AND v_won IS NOT NULL THEN
      NEW.stage_id := v_won;
    ELSIF NEW.status = 'open' AND OLD.stage_id IN (v_lost, v_won) THEN
      -- Reopened: back to where it was before, else the first stage.
      SELECT e.stage_id INTO v_back
      FROM deal_stage_events e
      JOIN pipeline_stages s ON s.id = e.stage_id AND s.pipeline_id = NEW.pipeline_id
      WHERE e.deal_id = NEW.id
        AND e.stage_id IS DISTINCT FROM v_lost
        AND e.stage_id IS DISTINCT FROM v_won
      ORDER BY e.created_at DESC
      LIMIT 1;
      IF v_back IS NULL THEN
        SELECT id INTO v_back FROM pipeline_stages
        WHERE pipeline_id = NEW.pipeline_id
          AND id IS DISTINCT FROM v_lost AND id IS DISTINCT FROM v_won
        ORDER BY position LIMIT 1;
      END IF;
      IF v_back IS NOT NULL THEN
        NEW.stage_id := v_back;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_status_stage ON deals;
CREATE TRIGGER deals_status_stage
  BEFORE UPDATE OF stage_id, status ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_deals_status_stage();

-- The tag sync (053) and the stage history (055) listened to
-- "UPDATE OF stage_id", which Postgres does not fire when the stage is
-- changed by the BEFORE trigger above (e.g. "Mark as lost"). Both
-- functions already compare old and new values, so listen to every
-- update instead.
DROP TRIGGER IF EXISTS deals_stage_tags ON deals;
CREATE TRIGGER deals_stage_tags
  AFTER INSERT OR DELETE OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_deals_stage_tags();

DROP TRIGGER IF EXISTS deals_stage_history ON deals;
CREATE TRIGGER deals_stage_history
  AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_deals_stage_history();

-- ------------------------------------------------------------
-- Fix existing mismatches once.
-- ------------------------------------------------------------
-- Marked lost but not in the lost stage → move to "Muerto".
UPDATE deals d
SET stage_id = pipeline_lost_stage(d.pipeline_id), updated_at = now()
WHERE d.status = 'lost'
  AND pipeline_lost_stage(d.pipeline_id) IS NOT NULL
  AND d.stage_id IS DISTINCT FROM pipeline_lost_stage(d.pipeline_id);

-- In "Muerto" but still marked open → lost.
UPDATE deals d
SET status = 'lost', updated_at = now()
WHERE d.status = 'open'
  AND d.stage_id = pipeline_lost_stage(d.pipeline_id);
