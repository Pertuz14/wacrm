-- ============================================================
-- 053_pipeline_stage_tags.sql — one contact tag per pipeline stage
--
-- Every pipeline stage gets its own tag (same name and color). A
-- contact always carries exactly the tag of the stage its deal sits in,
-- per pipeline: when the deal is created, moved (by the AI sync, the
-- stale sweep, a closed sale or a drag on the board) or deleted, the
-- tags follow in the same transaction. That lets broadcasts target
-- "everyone in stage X" through the normal tag filter.
--
-- Stage renamed → tag renamed. Stage deleted → its tag is deleted.
-- When a contact has several deals in one pipeline, the newest one
-- decides (the same deal the AI sync moves).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS pipeline_stage_id uuid
    REFERENCES pipeline_stages(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_pipeline_stage
  ON tags(pipeline_stage_id) WHERE pipeline_stage_id IS NOT NULL;

-- ------------------------------------------------------------
-- Tag name for a stage: the stage name, or "Stage · Pipeline" when
-- another stage tag of the account already uses that name.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION stage_tag_name(p_stage uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM tags t
      WHERE t.account_id = p.account_id
        AND t.pipeline_stage_id IS NOT NULL
        AND t.pipeline_stage_id <> s.id
        AND lower(t.name) = lower(s.name)
    ) THEN s.name || ' · ' || p.name
    ELSE s.name
  END
  FROM pipeline_stages s
  JOIN pipelines p ON p.id = s.pipeline_id
  WHERE s.id = p_stage
$$;

-- ------------------------------------------------------------
-- Get (or create) the tag of a stage. An existing unlinked tag with
-- the same name is adopted instead of creating a duplicate.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_stage_tag(p_stage uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tag uuid;
  v_name text;
  v_account uuid;
  v_user uuid;
  v_color text;
BEGIN
  SELECT id INTO v_tag FROM tags WHERE pipeline_stage_id = p_stage;
  IF v_tag IS NOT NULL THEN
    RETURN v_tag;
  END IF;

  SELECT p.account_id, p.user_id, s.color
    INTO v_account, v_user, v_color
  FROM pipeline_stages s
  JOIN pipelines p ON p.id = s.pipeline_id
  WHERE s.id = p_stage;
  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;

  v_name := stage_tag_name(p_stage);

  SELECT id INTO v_tag
  FROM tags
  WHERE account_id = v_account
    AND pipeline_stage_id IS NULL
    AND lower(name) = lower(v_name)
  ORDER BY created_at
  LIMIT 1;

  IF v_tag IS NOT NULL THEN
    UPDATE tags SET pipeline_stage_id = p_stage, color = v_color WHERE id = v_tag;
  ELSE
    INSERT INTO tags (user_id, account_id, name, color, pipeline_stage_id)
    VALUES (v_user, v_account, v_name, v_color, p_stage)
    RETURNING id INTO v_tag;
  END IF;
  RETURN v_tag;
END;
$$;

-- ------------------------------------------------------------
-- Make the contact's stage tags for one pipeline match its newest
-- deal there (or remove them all when it has no deal left).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_contact_stage_tags(p_contact uuid, p_pipeline uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage uuid;
  v_tag uuid;
BEGIN
  IF p_contact IS NULL OR p_pipeline IS NULL THEN
    RETURN;
  END IF;
  -- Whole pipeline being deleted: its stage tags go with the stages.
  IF NOT EXISTS (SELECT 1 FROM pipelines WHERE id = p_pipeline) THEN
    RETURN;
  END IF;
  -- Contact being deleted (its deals get contact_id = NULL): nothing to tag.
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact) THEN
    RETURN;
  END IF;

  SELECT d.stage_id INTO v_stage
  FROM deals d
  WHERE d.contact_id = p_contact AND d.pipeline_id = p_pipeline
  ORDER BY d.created_at DESC
  LIMIT 1;

  IF v_stage IS NOT NULL THEN
    v_tag := ensure_stage_tag(v_stage);
  END IF;

  DELETE FROM contact_tags ct
  USING tags t, pipeline_stages s
  WHERE ct.contact_id = p_contact
    AND ct.tag_id = t.id
    AND t.pipeline_stage_id = s.id
    AND s.pipeline_id = p_pipeline
    AND t.id IS DISTINCT FROM v_tag;

  IF v_tag IS NOT NULL THEN
    INSERT INTO contact_tags (contact_id, tag_id)
    VALUES (p_contact, v_tag)
    ON CONFLICT (contact_id, tag_id) DO NOTHING;
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- Triggers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_deals_stage_tags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM sync_contact_stage_tags(OLD.contact_id, OLD.pipeline_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_OP = 'INSERT'
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
       OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
      PERFORM sync_contact_stage_tags(NEW.contact_id, NEW.pipeline_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS deals_stage_tags ON deals;
CREATE TRIGGER deals_stage_tags
  AFTER INSERT OR DELETE OR UPDATE OF stage_id, contact_id, pipeline_id ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_deals_stage_tags();

CREATE OR REPLACE FUNCTION trg_stages_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM ensure_stage_tag(NEW.id);
  ELSIF NEW.name IS DISTINCT FROM OLD.name OR NEW.color IS DISTINCT FROM OLD.color THEN
    UPDATE tags
      SET name = stage_tag_name(NEW.id), color = NEW.color
      WHERE pipeline_stage_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pipeline_stages_tag ON pipeline_stages;
CREATE TRIGGER pipeline_stages_tag
  AFTER INSERT OR UPDATE OF name, color ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION trg_stages_tag();

-- Pipeline renamed → refresh the "Stage · Pipeline" names that use it.
CREATE OR REPLACE FUNCTION trg_pipelines_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE tags t
      SET name = stage_tag_name(s.id)
      FROM pipeline_stages s
      WHERE t.pipeline_stage_id = s.id AND s.pipeline_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pipelines_tag ON pipelines;
CREATE TRIGGER pipelines_tag
  AFTER UPDATE OF name ON pipelines
  FOR EACH ROW EXECUTE FUNCTION trg_pipelines_tag();

-- These run only from the triggers above.
REVOKE ALL ON FUNCTION ensure_stage_tag(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sync_contact_stage_tags(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Backfill: a tag for every existing stage, then tag every contact
-- that already has a deal.
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT s.id FROM pipeline_stages s
    JOIN pipelines p ON p.id = s.pipeline_id
    ORDER BY p.created_at, s.position
  LOOP
    PERFORM ensure_stage_tag(r.id);
  END LOOP;

  FOR r IN SELECT DISTINCT contact_id, pipeline_id FROM deals LOOP
    PERFORM sync_contact_stage_tags(r.contact_id, r.pipeline_id);
  END LOOP;
END;
$$;
