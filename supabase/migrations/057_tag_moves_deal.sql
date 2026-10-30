-- ============================================================
-- 057_tag_moves_deal.sql — stage tag and deal, both ways
--
-- 053 made the contact's tags follow its deals. This makes the deals
-- follow the tags too, so one rule holds everywhere:
--
--   the contact has the tag of stage X  ⇔  its card sits in stage X
--
--   * Add a stage tag to a contact (contact page, automation, API) →
--     its card in that pipeline moves to that stage, or a card is
--     created there. The previous stage tag of that pipeline goes away.
--   * Remove the stage tag of the card's current stage → the card leaves
--     that pipeline (deleted). A won card is never deleted this way:
--     the tag is put back.
--   * set_contact_pipeline_stage(contact, pipeline, stage | null) does
--     the same from the inbox panel's per-pipeline stage picker.
--
-- Also: the synced SIMADI pipeline, created as "Sales Pipeline", is
-- renamed "SIMADI" (its stage tags follow), and tags the owner already
-- changed by hand are reconciled once (tag without card → card created;
-- card whose stage tag was removed → card removed, unless won).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Deal status a stage implies: lost / won stage of the sync, or a
-- stage named like "Compra finalizada"; anything else is open.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION stage_deal_status(p_stage uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM ai_pipeline_sync WHERE stage_lost_id = p_stage)
      OR EXISTS (SELECT 1 FROM ai_pipeline_programs WHERE stage_lost_id = p_stage)
      THEN 'lost'
    WHEN EXISTS (SELECT 1 FROM ai_pipeline_sync WHERE stage_won_id = p_stage)
      OR EXISTS (SELECT 1 FROM ai_pipeline_programs WHERE stage_won_id = p_stage)
      OR EXISTS (SELECT 1 FROM pipeline_stages WHERE id = p_stage
                 AND name ~* '(compra\s+finalizada|finalizad|ganad|\mwon\M)')
      THEN 'won'
    ELSE 'open'
  END
$$;

-- ------------------------------------------------------------
-- Put the contact's card of one pipeline in a stage (create it if
-- missing), or take it out of the pipeline (p_stage NULL). Returns
-- false when the card is won and was therefore kept.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_contact_stage(p_contact uuid, p_pipeline uuid, p_stage uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deal    record;
  v_contact record;
  v_owner   uuid;
  v_status  text;
  v_conv    uuid;
BEGIN
  SELECT id, stage_id, status INTO v_deal
  FROM deals
  WHERE contact_id = p_contact AND pipeline_id = p_pipeline
  ORDER BY created_at DESC
  LIMIT 1;

  IF p_stage IS NULL THEN
    IF v_deal.id IS NULL THEN
      RETURN true;
    END IF;
    IF v_deal.status = 'won' THEN
      RETURN false;
    END IF;
    DELETE FROM deals WHERE id = v_deal.id;
    RETURN true;
  END IF;

  v_status := stage_deal_status(p_stage);

  IF v_deal.id IS NOT NULL THEN
    IF v_deal.stage_id IS DISTINCT FROM p_stage THEN
      UPDATE deals SET stage_id = p_stage, status = v_status, updated_at = now()
      WHERE id = v_deal.id;
    END IF;
    RETURN true;
  END IF;

  SELECT id, account_id, name, phone INTO v_contact FROM contacts WHERE id = p_contact;
  SELECT user_id INTO v_owner FROM pipelines WHERE id = p_pipeline;
  SELECT id INTO v_conv FROM conversations
  WHERE contact_id = p_contact ORDER BY last_message_at DESC NULLS LAST LIMIT 1;

  INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, conversation_id, title, value, currency, status)
  VALUES (
    v_contact.account_id, v_owner, p_pipeline, p_stage, p_contact, v_conv,
    COALESCE(NULLIF(btrim(v_contact.name), ''), NULLIF('+' || ltrim(v_contact.phone, '+'), '+'), 'Cliente'),
    0,
    COALESCE((SELECT default_currency FROM accounts WHERE id = v_contact.account_id), 'USD'),
    v_status
  );
  RETURN true;
END;
$$;

-- ------------------------------------------------------------
-- Inbox panel: set (or clear) a contact's stage in one pipeline.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_contact_pipeline_stage(p_contact uuid, p_pipeline uuid, p_stage uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT account_id INTO v_account FROM contacts WHERE id = p_contact;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'agent') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pipelines WHERE id = p_pipeline AND account_id = v_account) THEN
    RAISE EXCEPTION 'pipeline not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_stage IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE id = p_stage AND pipeline_id = p_pipeline) THEN
    RAISE EXCEPTION 'stage not in pipeline' USING ERRCODE = 'P0002';
  END IF;
  RETURN apply_contact_stage(p_contact, p_pipeline, p_stage);
END;
$$;

REVOKE ALL ON FUNCTION apply_contact_stage(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION set_contact_pipeline_stage(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_contact_pipeline_stage(uuid, uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- Tag added / removed by a person, automation or API → move the card.
-- Only direct writes (trigger depth 1): the tag changes 053 makes
-- while syncing, and cascades when a whole tag is deleted, are ignored.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_contact_tags_move_deal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage    uuid;
  v_pipeline uuid;
  v_current  uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT t.pipeline_stage_id, s.pipeline_id INTO v_stage, v_pipeline
    FROM tags t JOIN pipeline_stages s ON s.id = t.pipeline_stage_id
    WHERE t.id = NEW.tag_id;
    IF v_stage IS NOT NULL AND EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id) THEN
      PERFORM apply_contact_stage(NEW.contact_id, v_pipeline, v_stage);
    END IF;
    RETURN NULL;
  END IF;

  -- DELETE
  SELECT t.pipeline_stage_id, s.pipeline_id INTO v_stage, v_pipeline
  FROM tags t JOIN pipeline_stages s ON s.id = t.pipeline_stage_id
  WHERE t.id = OLD.tag_id;
  IF v_stage IS NULL OR NOT EXISTS (SELECT 1 FROM contacts WHERE id = OLD.contact_id) THEN
    RETURN NULL;
  END IF;
  SELECT stage_id INTO v_current FROM deals
  WHERE contact_id = OLD.contact_id AND pipeline_id = v_pipeline
  ORDER BY created_at DESC LIMIT 1;
  IF v_current IS DISTINCT FROM v_stage THEN
    RETURN NULL; -- not the card's stage: nothing to undo
  END IF;
  IF NOT apply_contact_stage(OLD.contact_id, v_pipeline, NULL) THEN
    -- Won card: keep it, and keep its tag.
    INSERT INTO contact_tags (contact_id, tag_id) VALUES (OLD.contact_id, OLD.tag_id)
    ON CONFLICT (contact_id, tag_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS contact_tags_move_deal ON contact_tags;
CREATE TRIGGER contact_tags_move_deal
  AFTER INSERT OR DELETE ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION trg_contact_tags_move_deal();

-- ------------------------------------------------------------
-- "Sales Pipeline" → "SIMADI" (only the synced one, only that name).
-- ------------------------------------------------------------
UPDATE pipelines p
SET name = 'SIMADI'
FROM ai_pipeline_sync s
WHERE s.pipeline_id = p.id AND p.name = 'Sales Pipeline';

-- ------------------------------------------------------------
-- One-time reconcile of tags changed by hand before this migration.
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  -- Stage tag without a card in that stage → move/create the card
  -- (newest stage tag per contact and pipeline wins).
  FOR r IN
    SELECT DISTINCT ON (ct.contact_id, s.pipeline_id)
      ct.contact_id, s.pipeline_id, s.id AS stage_id
    FROM contact_tags ct
    JOIN tags t ON t.id = ct.tag_id
    JOIN pipeline_stages s ON s.id = t.pipeline_stage_id
    WHERE NOT EXISTS (
      SELECT 1 FROM deals d
      WHERE d.contact_id = ct.contact_id AND d.pipeline_id = s.pipeline_id AND d.stage_id = s.id
    )
    ORDER BY ct.contact_id, s.pipeline_id, ct.created_at DESC
  LOOP
    PERFORM apply_contact_stage(r.contact_id, r.pipeline_id, r.stage_id);
  END LOOP;

  -- Card whose stage tag exists but was removed from the contact → the
  -- card leaves the pipeline (won cards stay and get their tag back).
  FOR r IN
    SELECT DISTINCT ON (d.contact_id, d.pipeline_id)
      d.contact_id, d.pipeline_id, d.stage_id, d.status, t.id AS tag_id
    FROM deals d
    JOIN tags t ON t.pipeline_stage_id = d.stage_id
    WHERE d.contact_id IS NOT NULL
    ORDER BY d.contact_id, d.pipeline_id, d.created_at DESC
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM contact_tags WHERE contact_id = r.contact_id AND tag_id = r.tag_id);
    IF r.status = 'won' THEN
      INSERT INTO contact_tags (contact_id, tag_id) VALUES (r.contact_id, r.tag_id)
      ON CONFLICT (contact_id, tag_id) DO NOTHING;
    ELSE
      PERFORM apply_contact_stage(r.contact_id, r.pipeline_id, NULL);
    END IF;
  END LOOP;
END;
$$;
