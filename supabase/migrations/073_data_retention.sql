-- ============================================================
-- 073_data_retention.sql — keep the database small without losing
-- anything useful for metrics
--
-- Three technical logs grow forever: every AI call (ai_usage_log), every
-- automation run (automation_logs) and every step of every flow run
-- (flow_run_events). Read in-app notifications pile up too. Once a week
-- purge_old_records():
--
--   1. SUMMARISES each whole month older than 6 months into a monthly
--      table that is kept forever (calls, tokens, conversations; runs by
--      status; flow events by type) — so long-term metrics stay possible;
--   2. only then deletes those detailed rows, in the same transaction;
--   3. deletes notifications already read more than 90 days ago.
--
-- Never touched: messages, conversations, contacts, deals, stage history,
-- lead sources, payment alerts, broadcasts, flow runs themselves.
-- Whole months only, so a month is summarised exactly once.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_usage_monthly (
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month             date NOT NULL,
  mode              text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  calls             integer NOT NULL DEFAULT 0,
  conversations     integer NOT NULL DEFAULT 0,
  prompt_tokens     bigint  NOT NULL DEFAULT 0,
  completion_tokens bigint  NOT NULL DEFAULT 0,
  total_tokens      bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month, mode, provider, model)
);

CREATE TABLE IF NOT EXISTS automation_runs_monthly (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month          date NOT NULL,
  automation_id  uuid NOT NULL,          -- no FK: the summary outlives a deleted automation
  automation_name text,
  trigger_event  text NOT NULL,
  status         text NOT NULL,
  runs           integer NOT NULL DEFAULT 0,
  contacts       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month, automation_id, trigger_event, status)
);

CREATE TABLE IF NOT EXISTS flow_events_monthly (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month       date NOT NULL,
  flow_id     uuid NOT NULL,             -- no FK: kept if the flow is deleted
  event_type  text NOT NULL,
  events      integer NOT NULL DEFAULT 0,
  runs        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month, flow_id, event_type)
);

ALTER TABLE ai_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_events_monthly ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_monthly_select ON ai_usage_monthly;
CREATE POLICY ai_usage_monthly_select ON ai_usage_monthly FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS automation_runs_monthly_select ON automation_runs_monthly;
CREATE POLICY automation_runs_monthly_select ON automation_runs_monthly FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS flow_events_monthly_select ON flow_events_monthly;
CREATE POLICY flow_events_monthly_select ON flow_events_monthly FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION purge_old_records(p_keep_months integer DEFAULT 6, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- First day of the oldest month we keep in detail; everything before it
  -- is made of whole months.
  v_cutoff timestamptz := date_trunc('month', p_now) - make_interval(months => p_keep_months);
  v_ai     integer;
  v_auto   integer;
  v_flow   integer;
  v_notif  integer;
BEGIN
  -- 1. AI usage
  INSERT INTO ai_usage_monthly AS m
    (account_id, month, mode, provider, model, calls, conversations, prompt_tokens, completion_tokens, total_tokens)
  SELECT account_id, date_trunc('month', created_at)::date, mode, provider, model,
         count(*), count(DISTINCT conversation_id),
         sum(prompt_tokens), sum(completion_tokens), sum(total_tokens)
  FROM ai_usage_log
  WHERE created_at < v_cutoff
  GROUP BY 1, 2, 3, 4, 5
  ON CONFLICT (account_id, month, mode, provider, model) DO UPDATE SET
    calls = m.calls + EXCLUDED.calls,
    conversations = m.conversations + EXCLUDED.conversations,
    prompt_tokens = m.prompt_tokens + EXCLUDED.prompt_tokens,
    completion_tokens = m.completion_tokens + EXCLUDED.completion_tokens,
    total_tokens = m.total_tokens + EXCLUDED.total_tokens;
  DELETE FROM ai_usage_log WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_ai = ROW_COUNT;

  -- 2. Automation runs
  INSERT INTO automation_runs_monthly AS m
    (account_id, month, automation_id, automation_name, trigger_event, status, runs, contacts)
  SELECT l.account_id, date_trunc('month', l.created_at)::date, l.automation_id, max(a.name),
         l.trigger_event, l.status, count(*), count(DISTINCT l.contact_id)
  FROM automation_logs l
  LEFT JOIN automations a ON a.id = l.automation_id
  WHERE l.created_at < v_cutoff
  GROUP BY l.account_id, 2, l.automation_id, l.trigger_event, l.status
  ON CONFLICT (account_id, month, automation_id, trigger_event, status) DO UPDATE SET
    runs = m.runs + EXCLUDED.runs,
    contacts = m.contacts + EXCLUDED.contacts,
    automation_name = COALESCE(EXCLUDED.automation_name, m.automation_name);
  DELETE FROM automation_logs WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_auto = ROW_COUNT;

  -- 3. Flow steps (only of runs that already ended)
  INSERT INTO flow_events_monthly AS m (account_id, month, flow_id, event_type, events, runs)
  SELECT r.account_id, date_trunc('month', e.created_at)::date, r.flow_id, e.event_type,
         count(*), count(DISTINCT e.flow_run_id)
  FROM flow_run_events e
  JOIN flow_runs r ON r.id = e.flow_run_id
  WHERE e.created_at < v_cutoff AND r.status <> 'active'
  GROUP BY r.account_id, 2, r.flow_id, e.event_type
  ON CONFLICT (account_id, month, flow_id, event_type) DO UPDATE SET
    events = m.events + EXCLUDED.events,
    runs = m.runs + EXCLUDED.runs;
  DELETE FROM flow_run_events e
  USING flow_runs r
  WHERE r.id = e.flow_run_id AND e.created_at < v_cutoff AND r.status <> 'active';
  GET DIAGNOSTICS v_flow = ROW_COUNT;

  -- 4. Notifications already read long ago (no metric value)
  DELETE FROM notifications
  WHERE read_at IS NOT NULL AND created_at < p_now - interval '90 days';
  GET DIAGNOSTICS v_notif = ROW_COUNT;

  RETURN jsonb_build_object(
    'kept_from', v_cutoff,
    'ai_usage_rows', v_ai,
    'automation_log_rows', v_auto,
    'flow_event_rows', v_flow,
    'notifications', v_notif
  );
END;
$$;

REVOKE ALL ON FUNCTION purge_old_records(integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_old_records(integer, timestamptz) TO service_role;

-- The invitation flow (072) must also see data in the summary tables
-- before deleting an old account.
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

-- Weekly, Sunday 03:17 UTC (pg_cron enabled by 071).
SELECT cron.schedule(
  'rumbo-purge-old-records',
  '17 3 * * 0',
  $$SELECT public.purge_old_records()$$
);
