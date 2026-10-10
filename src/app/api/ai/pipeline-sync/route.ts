import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  SYNC_COLUMNS,
  rowToSettings,
  sweepStaleDeals,
  type PipelineSyncSettings,
} from '@/lib/ai/pipeline-sync'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

interface StageRow {
  id: string
  pipeline_id: string
  name: string
  position: number
}

function toResponse(settings: PipelineSyncSettings, pipelines: unknown[]) {
  return {
    enabled: settings.enabled,
    pipeline_id: settings.pipelineId,
    stage_new_id: settings.stageNewId,
    stage_interested_id: settings.stageInterestedId,
    stage_verify_id: settings.stageVerifyId,
    stage_lost_id: settings.stageLostId,
    lost_after_days: settings.lostAfterDays,
    pipelines,
  }
}

/** The account's pipelines with their stages, for the settings dropdowns. */
async function listPipelines(
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'],
  accountId: string,
) {
  const { data: pipelines } = await supabase
    .from('pipelines')
    .select('id, name')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  const list = (pipelines ?? []) as { id: string; name: string }[]
  if (list.length === 0) return []
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('id, pipeline_id, name, position')
    .in(
      'pipeline_id',
      list.map((p) => p.id),
    )
    .order('position', { ascending: true })
  const byPipeline = new Map<string, { id: string; name: string }[]>()
  for (const s of (stages ?? []) as StageRow[]) {
    const arr = byPipeline.get(s.pipeline_id) ?? []
    arr.push({ id: s.id, name: s.name })
    byPipeline.set(s.pipeline_id, arr)
  }
  return list.map((p) => ({ id: p.id, name: p.name, stages: byPipeline.get(p.id) ?? [] }))
}

/**
 * GET /api/ai/pipeline-sync  (any member)
 *
 * Settings + the account's pipelines. Also runs the (throttled) stale-
 * deal sweep, so opening the page catches up even on a quiet day.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const [{ data }, pipelines] = await Promise.all([
      supabase.from('ai_pipeline_sync').select(SYNC_COLUMNS).eq('account_id', accountId).maybeSingle(),
      listPipelines(supabase, accountId),
    ])
    const settings = rowToSettings(data as Parameters<typeof rowToSettings>[0])
    if (settings.enabled) await sweepStaleDeals(supabaseAdmin(), accountId)
    return NextResponse.json(toResponse(settings, pipelines))
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/pipeline-sync  (admin+)
 *
 * Body: { enabled, pipeline_id, stage_new_id, stage_interested_id,
 *         stage_verify_id, stage_lost_id, lost_after_days }
 * When enabled, the pipeline must belong to the account and the four
 * stages to that pipeline.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-pipeline-sync:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }

    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const enabled = body.enabled === true
    const pipelineId = str(body.pipeline_id)
    const stages = {
      stage_new_id: str(body.stage_new_id),
      stage_interested_id: str(body.stage_interested_id),
      stage_verify_id: str(body.stage_verify_id),
      stage_lost_id: str(body.stage_lost_id),
    }
    const days = Math.floor(Number(body.lost_after_days))
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return NextResponse.json({ error: t('ai.pipelineSyncInvalid') }, { status: 400 })
    }

    if (enabled) {
      const stageIds = Object.values(stages)
      if (!pipelineId || stageIds.some((id) => !id) || new Set(stageIds).size !== stageIds.length) {
        return NextResponse.json({ error: t('ai.pipelineSyncInvalid') }, { status: 400 })
      }
      const { data: pipeline } = await supabase
        .from('pipelines')
        .select('id')
        .eq('id', pipelineId)
        .eq('account_id', accountId)
        .maybeSingle()
      const { data: owned } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipelineId)
        .in('id', stageIds as string[])
      if (!pipeline || (owned ?? []).length !== stageIds.length) {
        return NextResponse.json({ error: t('ai.pipelineSyncInvalid') }, { status: 400 })
      }
    }

    const { error } = await supabase.from('ai_pipeline_sync').upsert(
      {
        account_id: accountId,
        enabled,
        pipeline_id: pipelineId,
        ...stages,
        lost_after_days: days,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[ai/pipeline-sync POST] save failed:', error)
      return NextResponse.json({ error: t('ai.pipelineSyncSaveFailed') }, { status: 500 })
    }

    const { data } = await supabase
      .from('ai_pipeline_sync')
      .select(SYNC_COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle()
    return NextResponse.json(
      toResponse(
        rowToSettings(data as Parameters<typeof rowToSettings>[0]),
        await listPipelines(supabase, accountId),
      ),
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
