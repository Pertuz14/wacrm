-- ============================================================
-- 071_scheduled_sweep.sql — move silent cards to "Muerto" every hour,
-- inside the database
--
-- Before, the 20-day sweep only ran when a WhatsApp message arrived or
-- someone opened the pipeline-sync settings. pg_cron (built into
-- Supabase, free) now runs sweep_all_stale_deals() (070) at minute 7 of
-- every hour, whether or not anyone writes. The app keeps its own lazy
-- call as a fallback; both are safe to run together.
--
-- Idempotent — re-running just updates the same job.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.schedule(
  'rumbo-sweep-stale-deals',
  '7 * * * *',
  $$SELECT public.sweep_all_stale_deals()$$
);
