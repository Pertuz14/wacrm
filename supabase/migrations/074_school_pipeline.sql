-- ============================================================
-- 074_school_pipeline.sql — schools that ask for the diagnostic (Rumbo a la U, plan v9 W5)
--
-- Schools write from rumbouni.com/colegios with «Hola, escribo de un colegio y quiero información
-- sobre el diagnóstico para 5.º año (vi la web)». They are not students, so:
--   * a lead source of their own, 'colegio', for the Monday origin report;
--   * a fourth program, 'colegio', with its own pipeline «Colegios»
--     (Nuevo → Contactado → Diagnóstico programado → Aliado → Pausado). The bot marks
--     [[ETIQUETA:programa_colegio]] with its M19 reply; later stages are moved by hand.
--     The stale sweep moves a school with no activity to «Pausado».
--
-- Idempotent — safe to run multiple times. Accounts that already have a 'colegio' row are left alone.
-- Revert: DELETE FROM ai_pipeline_programs WHERE program = 'colegio'; (and delete the «Colegios» pipeline by hand)
-- ============================================================

-- 1) The program list accepts 'colegio'
ALTER TABLE ai_pipeline_programs DROP CONSTRAINT IF EXISTS ai_pipeline_programs_program_check;
ALTER TABLE ai_pipeline_programs
  ADD CONSTRAINT ai_pipeline_programs_program_check CHECK (program IN ('ucab', 'propedeutico', 'colegio'));

-- 2) Label of the new lead source (same text as LEAD_SOURCE_LABELS in src/lib/leads/source.ts)
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
    WHEN 'colegio'              THEN 'Colegio (diagnóstico)'
    WHEN 'tiktok'               THEN 'TikTok'
    WHEN 'instagram'            THEN 'Instagram'
    WHEN 'comentario_instagram' THEN 'Comentario en Instagram'
    WHEN 'facebook'             THEN 'Facebook'
    WHEN 'youtube'              THEN 'YouTube'
    WHEN 'whatsapp'             THEN 'WhatsApp directo'
    WHEN 'otro'                 THEN 'Otro'
    ELSE NULL                   -- sin_dato: no tag (as in 055)
  END
$$;

-- 3) The «Colegios» pipeline, for every account whose SIMADI sync is configured
DO $$
DECLARE
  s       record;
  v_pipe  uuid;
  v_ids   uuid[] := '{}';
  v_stage uuid;
  st      record;
BEGIN
  FOR s IN
    SELECT ps.account_id, p.user_id AS pipeline_user
    FROM ai_pipeline_sync ps
    JOIN pipelines p ON p.id = ps.pipeline_id
    WHERE ps.pipeline_id IS NOT NULL
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM ai_pipeline_programs WHERE account_id = s.account_id AND program = 'colegio');

    INSERT INTO pipelines (user_id, account_id, name)
    VALUES (s.pipeline_user, s.account_id, 'Colegios')
    RETURNING id INTO v_pipe;

    v_ids := '{}';
    FOR st IN
      SELECT * FROM (VALUES
        (0, 'Nuevo', '#3b82f6'),
        (1, 'Contactado', '#8b5cf6'),
        (2, 'Diagnóstico programado', '#f59e0b'),
        (3, 'Aliado', '#22c55e'),
        (4, 'Pausado', '#94a3b8')
      ) AS v(position, name, color)
      ORDER BY position
    LOOP
      INSERT INTO pipeline_stages (pipeline_id, name, position, color)
      VALUES (v_pipe, st.name, st.position, st.color)
      RETURNING id INTO v_stage;
      v_ids := v_ids || v_stage;
    END LOOP;

    INSERT INTO ai_pipeline_programs (
      account_id, program, pipeline_id,
      stage_new_id, stage_interested_id, stage_verify_id, stage_won_id, stage_lost_id
    ) VALUES (
      s.account_id, 'colegio', v_pipe,
      v_ids[1], v_ids[2], v_ids[3], v_ids[4], v_ids[5]
    );
  END LOOP;
END;
$$;
