import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadPipelineSync,
  loadProgramPipelines,
  resolveWonStage,
  type Program,
  type ProgramPipeline,
} from '@/lib/ai/pipeline-sync'
import { LEAD_SOURCE_LABELS, type LeadSource } from './source'

// ============================================================
// Origin report: every arrival (lead_sources) in a period, and how far
// each of those contacts got in each program's pipeline (from
// deal_stage_events, so a lead that reached "verify" and later went
// lost still counts as having reached it). No names or phones: contacts
// are identified by the first 8 characters of their id.
// ============================================================

export type Reached = 'nuevo' | 'interesado' | 'verificar' | 'venta'

const RANK: Record<Reached, number> = { nuevo: 1, interesado: 2, verificar: 3, venta: 4 }

export interface ReportTouch {
  date: string
  channel: string
  source: string
  source_label: string
  detail: string | null
  ad_id: string | null
  first_touch: boolean
  backfilled: boolean
  contact: string
}

export interface ReportOutcome {
  program: Program
  reached: Reached | null
  lost: boolean
  won: boolean
  value_usd: number
}

export interface ReportContact {
  contact: string
  outcomes: ReportOutcome[]
}

export interface LeadSourceReport {
  generated_at: string
  since: string
  touches: ReportTouch[]
  contacts: ReportContact[]
}

const short = (id: string) => id.slice(0, 8)

/** Split a list for `.in()` filters (long URLs fail). */
function chunks<T>(list: T[], size = 150): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

interface StageKinds {
  program: Program
  kinds: Map<string, Reached | 'perdido'>
}

/** stage id → what reaching it means, per program pipeline. */
export function stageKinds(p: ProgramPipeline, wonStageId: string | null): Map<string, Reached | 'perdido'> {
  const m = new Map<string, Reached | 'perdido'>()
  if (p.stageNewId) m.set(p.stageNewId, 'nuevo')
  if (p.stageInterestedId) m.set(p.stageInterestedId, 'interesado')
  if (p.stageVerifyId) m.set(p.stageVerifyId, 'verificar')
  if (p.stageLostId) m.set(p.stageLostId, 'perdido')
  if (wonStageId) m.set(wonStageId, 'venta')
  return m
}

/** Furthest stage reached among the stages a deal went through. */
export function furthest(stageIds: string[], kinds: Map<string, Reached | 'perdido'>): Reached | null {
  let best: Reached | null = null
  for (const id of stageIds) {
    const k = kinds.get(id)
    if (!k || k === 'perdido') continue
    if (!best || RANK[k] > RANK[best]) best = k
  }
  return best
}

export async function buildLeadSourceReport(
  db: SupabaseClient,
  accountId: string,
  since: Date,
): Promise<LeadSourceReport> {
  const { data: rows, error } = await db
    .from('lead_sources')
    .select('contact_id, channel, source, detail, ad_id, is_first_touch, backfilled, created_at')
    .eq('account_id', accountId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true })
    .limit(20000)
  if (error) throw error

  type Row = {
    contact_id: string
    channel: string
    source: string
    detail: string | null
    ad_id: string | null
    is_first_touch: boolean
    backfilled: boolean
    created_at: string
  }
  const touches = (rows ?? []) as Row[]
  const contactIds = [...new Set(touches.map((t) => t.contact_id))]

  // Programs and what each of their stages means.
  const settings = await loadPipelineSync(db, accountId)
  const programs: StageKinds[] = []
  const byPipeline = new Map<string, StageKinds>()
  if (settings) {
    for (const p of await loadProgramPipelines(db, accountId, settings, { requireStages: false })) {
      const entry = { program: p.program ?? 'simadi', kinds: stageKinds(p, await resolveWonStage(db, p)) }
      programs.push(entry)
      byPipeline.set(p.pipelineId!, entry)
    }
  }

  // Stage history and current state of those contacts' deals.
  const reachedStages = new Map<string, string[]>() // contact|pipeline → stage ids
  const current = new Map<string, { status: string; value: number }[]>()
  if (byPipeline.size > 0) {
    for (const ids of chunks(contactIds)) {
      const [{ data: events }, { data: deals }] = await Promise.all([
        db
          .from('deal_stage_events')
          .select('contact_id, pipeline_id, stage_id')
          .eq('account_id', accountId)
          .in('contact_id', ids)
          .in('pipeline_id', [...byPipeline.keys()]),
        db
          .from('deals')
          .select('contact_id, pipeline_id, stage_id, status, value')
          .eq('account_id', accountId)
          .in('contact_id', ids)
          .in('pipeline_id', [...byPipeline.keys()]),
      ])
      for (const e of (events ?? []) as { contact_id: string; pipeline_id: string; stage_id: string }[]) {
        const key = `${e.contact_id}|${e.pipeline_id}`
        reachedStages.set(key, [...(reachedStages.get(key) ?? []), e.stage_id])
      }
      for (const d of (deals ?? []) as { contact_id: string; pipeline_id: string; stage_id: string; status: string; value: number }[]) {
        const key = `${d.contact_id}|${d.pipeline_id}`
        // Deals older than the history table still count by their current stage.
        reachedStages.set(key, [...(reachedStages.get(key) ?? []), d.stage_id])
        current.set(key, [...(current.get(key) ?? []), { status: d.status, value: Number(d.value) || 0 }])
      }
    }
  }

  const contacts: ReportContact[] = contactIds.map((id) => {
    const outcomes: ReportOutcome[] = []
    for (const [pipelineId, entry] of byPipeline) {
      const key = `${id}|${pipelineId}`
      const stages = reachedStages.get(key)
      if (!stages) continue
      const deals = current.get(key) ?? []
      const won = deals.some((d) => d.status === 'won') || stages.some((s) => entry.kinds.get(s) === 'venta')
      outcomes.push({
        program: entry.program,
        reached: won ? 'venta' : furthest(stages, entry.kinds),
        lost: !won && deals.length > 0 && deals.every((d) => d.status === 'lost'),
        won,
        value_usd: deals.filter((d) => d.status === 'won').reduce((s, d) => s + d.value, 0),
      })
    }
    return { contact: short(id), outcomes }
  })

  return {
    generated_at: new Date().toISOString(),
    since: since.toISOString(),
    touches: touches.map((t) => ({
      date: t.created_at,
      channel: t.channel,
      source: t.source,
      source_label: LEAD_SOURCE_LABELS[t.source as LeadSource] ?? t.source,
      detail: t.detail,
      ad_id: t.ad_id,
      first_touch: t.is_first_touch,
      backfilled: t.backfilled,
      contact: short(t.contact_id),
    })),
    contacts,
  }
}
