-- ============================================================
-- 055_lead_sources.sql — where each customer came from, and how far
-- they got
--
--   * lead_sources — one row per "arrival": the contact's first message
--     ever (is_first_touch) and every later message that carries a new
--     origin (a click on an ad, a link from the web or TikTok…). Filled
--     by the WhatsApp and Instagram webhooks (src/lib/leads/source.ts).
--     For ads it keeps Meta's ad id, headline and click id.
--   * deal_stage_events — every stage a deal enters (trigger on deals),
--     so reports can count how many leads of each origin reached
--     "interested", "verify" and "won", even if they later went lost.
--   * Each arrival tags the contact "Origen: …" (one tag per origin), so
--     broadcasts can target by origin too.
--
-- Existing contacts are backfilled from their first message (ad
-- placeholder, "(vi la web)", TikTok mention, Instagram); the rest are
-- "sin_dato" — the CRM did not record origins before this migration.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  channel          text NOT NULL,                 -- whatsapp | instagram
  source           text NOT NULL,                 -- see lead_source_label()
  detail           text,                          -- ad headline, keyword, page…
  ad_id            text,                          -- Meta ad id (referral.source_id / ad_id)
  source_url       text,
  click_id         text,                          -- ctwa_clid
  first_message    text,
  is_first_touch   boolean NOT NULL DEFAULT false,
  backfilled       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_sources_account_created ON lead_sources(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lead_sources_contact ON lead_sources(contact_id);

ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_sources_select ON lead_sources;
CREATE POLICY lead_sources_select ON lead_sources FOR SELECT
  USING (is_account_member(account_id));
-- Writes: service role only (webhooks).

CREATE TABLE IF NOT EXISTS deal_stage_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  pipeline_id  uuid NOT NULL,
  stage_id     uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_stage_events_account ON deal_stage_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deal_stage_events_contact ON deal_stage_events(contact_id);

ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_stage_events_select ON deal_stage_events;
CREATE POLICY deal_stage_events_select ON deal_stage_events FOR SELECT
  USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- Stage history
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_deals_stage_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_events (account_id, deal_id, contact_id, pipeline_id, stage_id)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, NEW.pipeline_id, NEW.stage_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS deals_stage_history ON deals;
CREATE TRIGGER deals_stage_history
  AFTER INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_deals_stage_history();

-- ------------------------------------------------------------
-- "Origen: …" tags
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION lead_source_label(p_source text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_source
    WHEN 'anuncio_instagram'    THEN 'Anuncio de Instagram'
    WHEN 'anuncio_facebook'     THEN 'Anuncio de Facebook'
    WHEN 'anuncio_meta'         THEN 'Anuncio de Meta'
    WHEN 'publicacion'          THEN 'Publicación de Facebook o Instagram'
    WHEN 'web'                  THEN 'Página web'
    WHEN 'tiktok'               THEN 'TikTok'
    WHEN 'instagram'            THEN 'Instagram'
    WHEN 'comentario_instagram' THEN 'Comentario en Instagram'
    WHEN 'facebook'             THEN 'Facebook'
    WHEN 'youtube'              THEN 'YouTube'
    WHEN 'whatsapp'             THEN 'WhatsApp directo'
    WHEN 'otro'                 THEN 'Otro'
    ELSE NULL                   -- sin_dato: no tag
  END
$$;

CREATE OR REPLACE FUNCTION trg_lead_sources_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label text := lead_source_label(NEW.source);
  v_name  text;
  v_user  uuid;
  v_tag   uuid;
BEGIN
  IF v_label IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT user_id INTO v_user FROM contacts WHERE id = NEW.contact_id;
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  v_name := 'Origen: ' || v_label;

  SELECT id INTO v_tag FROM tags
  WHERE account_id = NEW.account_id AND lower(name) = lower(v_name)
  ORDER BY created_at LIMIT 1;
  IF v_tag IS NULL THEN
    INSERT INTO tags (user_id, account_id, name, color)
    VALUES (v_user, NEW.account_id, v_name, '#64748b')
    RETURNING id INTO v_tag;
  END IF;

  INSERT INTO contact_tags (contact_id, tag_id)
  VALUES (NEW.contact_id, v_tag)
  ON CONFLICT (contact_id, tag_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS lead_sources_tag ON lead_sources;
CREATE TRIGGER lead_sources_tag
  AFTER INSERT ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION trg_lead_sources_tag();

-- ------------------------------------------------------------
-- Backfill
-- ------------------------------------------------------------

-- Current stage of every existing deal (history starts today).
INSERT INTO deal_stage_events (account_id, deal_id, contact_id, pipeline_id, stage_id, created_at)
SELECT d.account_id, d.id, d.contact_id, d.pipeline_id, d.stage_id, COALESCE(d.updated_at, d.created_at, now())
FROM deals d
WHERE NOT EXISTS (SELECT 1 FROM deal_stage_events e WHERE e.deal_id = d.id);

-- First customer message of every contact without an origin yet.
INSERT INTO lead_sources (account_id, contact_id, conversation_id, channel, source, detail, first_message, is_first_touch, backfilled, created_at)
SELECT
  f.account_id, f.contact_id, f.conversation_id, f.channel,
  CASE
    WHEN f.channel = 'instagram' AND f.from_comment THEN 'comentario_instagram'
    WHEN f.channel = 'instagram' THEN 'instagram'
    WHEN f.content_text LIKE '%llegó desde el anuncio «%' THEN 'anuncio_meta'
    WHEN f.content_text ILIKE '%(vi la web)%' THEN 'web'
    WHEN f.content_text ILIKE '%tiktok%' THEN 'tiktok'
    ELSE 'sin_dato'
  END,
  CASE
    WHEN f.content_text LIKE '%llegó desde el anuncio «%'
      THEN substring(f.content_text FROM 'anuncio «(.+)»')
    ELSE NULL
  END,
  left(f.content_text, 500), true, true, f.created_at
FROM (
  SELECT DISTINCT ON (c.id)
    c.account_id, c.id AS contact_id, cv.id AS conversation_id, cv.channel,
    m.content_text, m.created_at,
    (c.ig_user_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM instagram_comment_replies r
      WHERE r.account_id = c.account_id AND r.from_id = c.ig_user_id
    )) AS from_comment
  FROM contacts c
  JOIN conversations cv ON cv.contact_id = c.id
  JOIN messages m ON m.conversation_id = cv.id AND m.sender_type = 'customer'
  WHERE NOT EXISTS (SELECT 1 FROM lead_sources l WHERE l.contact_id = c.id)
  ORDER BY c.id, m.created_at
) f;
