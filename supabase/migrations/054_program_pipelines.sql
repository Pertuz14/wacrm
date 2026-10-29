-- ============================================================
-- 054_program_pipelines.sql — one synced pipeline per program
--
-- The AI sync (048) moved deals in a single pipeline (SIMADI). Rumbo a
-- la U sells three programs, so UCAB and Propedéutico get their own
-- pipelines that move exactly the same way: the bot tells which program
-- the conversation is about ([[ETIQUETA:programa_ucab]] /
-- programa_propedeutico / programa_simadi) and the deal is created and
-- advanced in that program's pipeline.
--
--   * ai_pipeline_sync keeps the switch, the days-to-lost and the SIMADI
--     pipeline (unchanged).
--   * ai_pipeline_programs holds the other programs' pipeline + stages.
--
-- On first run, for every account whose SIMADI sync is configured, the
-- SIMADI pipeline is copied twice (same stages, order and colors; the
-- word "SIMADI" in a name is replaced by the program) and the copies are
-- mapped stage by stage. Accounts that already have a program row are
-- left alone, so renaming or editing the copies later is safe.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 051 may not be applied yet; the copy below reads stage_won_id.
ALTER TABLE ai_pipeline_sync
  ADD COLUMN IF NOT EXISTS stage_won_id uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ai_pipeline_programs (
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  program              text NOT NULL CHECK (program IN ('ucab', 'propedeutico')),
  pipeline_id          uuid REFERENCES pipelines(id) ON DELETE SET NULL,
  stage_new_id         uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_interested_id  uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_verify_id      uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_lost_id        uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_won_id         uuid REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, program)
);

ALTER TABLE ai_pipeline_programs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_pipeline_programs_select ON ai_pipeline_programs;
CREATE POLICY ai_pipeline_programs_select ON ai_pipeline_programs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_pipeline_programs_insert ON ai_pipeline_programs;
CREATE POLICY ai_pipeline_programs_insert ON ai_pipeline_programs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_pipeline_programs_update ON ai_pipeline_programs;
CREATE POLICY ai_pipeline_programs_update ON ai_pipeline_programs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_pipeline_programs_delete ON ai_pipeline_programs;
CREATE POLICY ai_pipeline_programs_delete ON ai_pipeline_programs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Copy the SIMADI pipeline for UCAB and Propedéutico.
-- ------------------------------------------------------------
DO $$
DECLARE
  s       record;
  prog    record;
  st      record;
  v_pipe  uuid;
  v_stage uuid;
  v_map   jsonb;
  v_name  text;
BEGIN
  FOR s IN
    SELECT ps.account_id, ps.pipeline_id, ps.stage_new_id, ps.stage_interested_id,
           ps.stage_verify_id, ps.stage_lost_id, ps.stage_won_id,
           p.name AS pipeline_name, p.user_id AS pipeline_user
    FROM ai_pipeline_sync ps
    JOIN pipelines p ON p.id = ps.pipeline_id
    WHERE ps.stage_new_id IS NOT NULL
      AND ps.stage_interested_id IS NOT NULL
      AND ps.stage_verify_id IS NOT NULL
      AND ps.stage_lost_id IS NOT NULL
  LOOP
    FOR prog IN
      SELECT * FROM (VALUES ('ucab', 'UCAB'), ('propedeutico', 'Propedéutico')) AS v(code, label)
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM ai_pipeline_programs
        WHERE account_id = s.account_id AND program = prog.code
      );

      v_name := regexp_replace(s.pipeline_name, 'simadi', prog.label, 'gi');
      IF v_name = s.pipeline_name THEN
        v_name := prog.label;
      END IF;

      INSERT INTO pipelines (user_id, account_id, name)
      VALUES (s.pipeline_user, s.account_id, v_name)
      RETURNING id INTO v_pipe;

      v_map := '{}'::jsonb;
      FOR st IN
        SELECT id, name, position, color FROM pipeline_stages
        WHERE pipeline_id = s.pipeline_id
        ORDER BY position, created_at
      LOOP
        INSERT INTO pipeline_stages (pipeline_id, name, position, color)
        VALUES (v_pipe, regexp_replace(st.name, 'simadi', prog.label, 'gi'), st.position, st.color)
        RETURNING id INTO v_stage;
        v_map := v_map || jsonb_build_object(st.id::text, v_stage::text);
      END LOOP;

      INSERT INTO ai_pipeline_programs (
        account_id, program, pipeline_id,
        stage_new_id, stage_interested_id, stage_verify_id, stage_lost_id, stage_won_id
      ) VALUES (
        s.account_id, prog.code, v_pipe,
        (v_map ->> s.stage_new_id::text)::uuid,
        (v_map ->> s.stage_interested_id::text)::uuid,
        (v_map ->> s.stage_verify_id::text)::uuid,
        (v_map ->> s.stage_lost_id::text)::uuid,
        (v_map ->> s.stage_won_id::text)::uuid
      );
    END LOOP;
  END LOOP;
END;
$$;
