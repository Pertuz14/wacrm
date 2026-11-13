-- ============================================================
-- 075_meta_capi.sql — tell Meta who wrote and who bought (Conversions API)
--
--   * capi_events — an outbox. A trigger adds one row for every stage a
--     deal enters (deal_stage_events) and for every arrival from an ad
--     (lead_sources with an 'anuncio_*' source). The app
--     (src/lib/meta/capi-queue.ts) decides which ones become a Meta event
--     (LeadSubmitted, QualifiedLead, InitiateCheckout, Purchase), sends
--     them and records the outcome. Nothing leaves the database while the
--     app's META_CAPI_ACTIVO is off; rows older than 7 days expire, since
--     Meta refuses events older than that.
--   * lead_sources.visit_code — the website's visit code, hidden in the
--     WhatsApp text with zero-width characters (like the school code), so
--     a sale can be matched to the browser that clicked the ad.
--   * One sent event per deal and event name (unique index): a deal that
--     goes Interesado → Muerto → Interesado is reported once.
--
-- The schedule that calls the app every 5 minutes is NOT here: it needs
-- the app URL and a secret, see crm/«Supabase 5 - envío a Meta cada 5 minutos.sql».
--
-- Idempotent — safe to run multiple times.
-- Revert: DROP TABLE capi_events; DROP FUNCTION trg_capi_from_stage, trg_capi_from_lead_source;
--         ALTER TABLE lead_sources DROP COLUMN visit_code;
-- ============================================================

ALTER TABLE lead_sources ADD COLUMN IF NOT EXISTS visit_code text;

CREATE TABLE IF NOT EXISTS capi_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id          uuid REFERENCES deals(id) ON DELETE SET NULL,
  -- what queued it: a stage event or an arrival from an ad
  stage_event_id   uuid UNIQUE REFERENCES deal_stage_events(id) ON DELETE SET NULL,
  lead_source_id   uuid UNIQUE REFERENCES lead_sources(id) ON DELETE SET NULL,
  pipeline_id      uuid,
  stage_id         uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  -- filled by the app
  event_name       text,                -- LeadSubmitted | QualifiedLead | InitiateCheckout | Purchase
  channel          text,                -- whatsapp | instagram | website
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'skipped', 'error', 'expired')),
  reason           text,                -- why skipped / the error
  attempts         int NOT NULL DEFAULT 0,
  value_usd        numeric(12, 2),
  meta_event_id    text,                -- event_id sent to Meta
  test_mode        boolean NOT NULL DEFAULT false,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capi_events_pending ON capi_events(account_id, created_at) WHERE status IN ('pending', 'error');
CREATE INDEX IF NOT EXISTS idx_capi_events_contact ON capi_events(contact_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_capi_events_deal_event
  ON capi_events(deal_id, event_name) WHERE status = 'sent' AND deal_id IS NOT NULL AND NOT test_mode;

ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capi_events_select ON capi_events;
CREATE POLICY capi_events_select ON capi_events FOR SELECT
  USING (is_account_member(account_id));
-- Writes: service role only (triggers below and the app).

-- ------------------------------------------------------------
-- Queue every stage a deal enters
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_capi_from_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO capi_events (account_id, contact_id, deal_id, stage_event_id, pipeline_id, stage_id, occurred_at)
  VALUES (NEW.account_id, NEW.contact_id, NEW.deal_id, NEW.id, NEW.pipeline_id, NEW.stage_id, NEW.created_at)
  ON CONFLICT (stage_event_id) DO NOTHING;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL; -- the CAPI must never block a stage change
END;
$$;

DROP TRIGGER IF EXISTS capi_from_stage ON deal_stage_events;
CREATE TRIGGER capi_from_stage
  AFTER INSERT ON deal_stage_events
  FOR EACH ROW EXECUTE FUNCTION trg_capi_from_stage();

-- ------------------------------------------------------------
-- Queue every arrival from an ad
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_capi_from_lead_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.source LIKE 'anuncio\_%' AND NOT NEW.backfilled THEN
    INSERT INTO capi_events (account_id, contact_id, lead_source_id, occurred_at)
    VALUES (NEW.account_id, NEW.contact_id, NEW.id, NEW.created_at)
    ON CONFLICT (lead_source_id) DO NOTHING;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS capi_from_lead_source ON lead_sources;
CREATE TRIGGER capi_from_lead_source
  AFTER INSERT ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION trg_capi_from_lead_source();

-- ------------------------------------------------------------
-- The invitation flow (072/073) must also see data in capi_events
-- before deleting an old account (same body as 073 plus that table).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_pricing WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_pipeline_sync WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_pipeline_programs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM push_subscriptions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM instagram_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM instagram_comment_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_alerts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM lead_sources WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deal_stage_events WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_monthly WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_runs_monthly WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_events_monthly WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM capi_events WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
