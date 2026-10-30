-- ============================================================
-- 056_editable_auto_tags.sql — automatic tags you can rename
--
-- 055 found the "Origen: …" tag of each origin by its name, so renaming
-- it in Settings › Fields & tags made the next arrival create a new tag
-- with the old name. Now each origin tag is linked to its origin
-- (tags.lead_source) the way stage tags are linked to their stage
-- (053, tags.pipeline_stage_id): rename it or change its color freely.
--
-- Stage tags keep following their stage's name: rename the stage in
-- Pipelines and the tag follows (renaming the tag directly lasts only
-- until the stage is renamed).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE tags ADD COLUMN IF NOT EXISTS lead_source text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_lead_source
  ON tags(account_id, lead_source) WHERE lead_source IS NOT NULL;

-- Link the origin tags 055 already created (by their current name).
UPDATE tags t
SET lead_source = s.code
FROM (
  SELECT code, 'Origen: ' || lead_source_label(code) AS name
  FROM unnest(ARRAY[
    'anuncio_instagram', 'anuncio_facebook', 'anuncio_meta', 'publicacion', 'web', 'tiktok',
    'instagram', 'comentario_instagram', 'facebook', 'youtube', 'whatsapp', 'otro'
  ]) AS code
) s
WHERE lower(t.name) = lower(s.name)
  AND t.lead_source IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM tags x WHERE x.account_id = t.account_id AND x.lead_source = s.code
  );

CREATE OR REPLACE FUNCTION trg_lead_sources_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text := lead_source_label(NEW.source);
  v_user  uuid;
  v_tag   uuid;
BEGIN
  IF v_label IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_tag FROM tags
  WHERE account_id = NEW.account_id AND lead_source = NEW.source;

  IF v_tag IS NULL THEN
    SELECT user_id INTO v_user FROM contacts WHERE id = NEW.contact_id;
    IF v_user IS NULL THEN
      RETURN NULL;
    END IF;
    INSERT INTO tags (user_id, account_id, name, color, lead_source)
    VALUES (v_user, NEW.account_id, 'Origen: ' || v_label, '#64748b', NEW.source)
    ON CONFLICT (account_id, lead_source) WHERE lead_source IS NOT NULL DO NOTHING
    RETURNING id INTO v_tag;
    IF v_tag IS NULL THEN
      SELECT id INTO v_tag FROM tags
      WHERE account_id = NEW.account_id AND lead_source = NEW.source;
    END IF;
  END IF;

  INSERT INTO contact_tags (contact_id, tag_id)
  VALUES (NEW.contact_id, v_tag)
  ON CONFLICT (contact_id, tag_id) DO NOTHING;
  RETURN NULL;
END;
$$;
