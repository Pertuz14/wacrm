-- ============================================================
-- 076_rumbo_bot_versions.sql — Rumbo (RUMBO.md, cambio 9): historial del texto del bot
--
--   * rumbo_bot_versions — cada vez que cambia el «Contexto del negocio» del agente
--     (ai_configs.system_prompt) o la nota de la IA de Instagram
--     (instagram_config.ai_channel_note), un disparador guarda aquí el texto ANTERIOR.
--     Da igual desde dónde se cambie (la pantalla, la API o una actualización directa):
--     siempre queda la versión previa, y la pantalla la puede volver a cargar.
--   * Se guardan las últimas 30 de cada canal y cuenta; las más viejas se borran solas.
--   * Tabla y funciones propias de Rumbo (prefijo rumbo_): no existen en el original.
--   * redeem_invitation (la de 075) también revisa rumbo_bot_versions antes de borrar una cuenta
--     vieja (lo exige src/lib/auth/redeem-invitation-migration.test.ts para toda tabla con account_id).
--
-- Idempotent — safe to run multiple times.
-- Revert: DROP TRIGGER rumbo_bot_version_ai ON ai_configs;
--         DROP TRIGGER rumbo_bot_version_ig ON instagram_config;
--         DROP FUNCTION rumbo_save_bot_version(); DROP TABLE rumbo_bot_versions;
-- ============================================================

CREATE TABLE IF NOT EXISTS rumbo_bot_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'instagram')),
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rumbo_bot_versions_lookup_idx
  ON rumbo_bot_versions (account_id, channel, created_at DESC);

ALTER TABLE rumbo_bot_versions ENABLE ROW LEVEL SECURITY;
-- Los miembros de la cuenta pueden leerlas (la pantalla); nadie escribe desde la app: solo el disparador.
DROP POLICY IF EXISTS rumbo_bot_versions_select ON rumbo_bot_versions;
CREATE POLICY rumbo_bot_versions_select ON rumbo_bot_versions FOR SELECT
  USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION rumbo_save_bot_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_channel text := TG_ARGV[0];
  v_old text;
  v_new text;
BEGIN
  IF v_channel = 'whatsapp' THEN
    v_old := OLD.system_prompt; v_new := NEW.system_prompt;
  ELSE
    v_old := OLD.ai_channel_note; v_new := NEW.ai_channel_note;
  END IF;
  IF v_old IS NULL OR btrim(v_old) = '' OR v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  INSERT INTO rumbo_bot_versions (account_id, channel, content) VALUES (NEW.account_id, v_channel, v_old);
  DELETE FROM rumbo_bot_versions
   WHERE account_id = NEW.account_id AND channel = v_channel
     AND id NOT IN (SELECT id FROM rumbo_bot_versions
                     WHERE account_id = NEW.account_id AND channel = v_channel
                     ORDER BY created_at DESC LIMIT 30);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rumbo_save_bot_version() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rumbo_bot_version_ai ON ai_configs;
CREATE TRIGGER rumbo_bot_version_ai AFTER UPDATE OF system_prompt ON ai_configs
  FOR EACH ROW EXECUTE FUNCTION rumbo_save_bot_version('whatsapp');

DROP TRIGGER IF EXISTS rumbo_bot_version_ig ON instagram_config;
CREATE TRIGGER rumbo_bot_version_ig AFTER UPDATE OF ai_channel_note ON instagram_config
  FOR EACH ROW EXECUTE FUNCTION rumbo_save_bot_version('instagram');

-- redeem_invitation: la misma de 075_meta_capi.sql, con rumbo_bot_versions en la lista
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
    UNION ALL SELECT 1 FROM rumbo_bot_versions WHERE account_id = v_old_account_id
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
