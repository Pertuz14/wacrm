import type { SupabaseClient } from '@supabase/supabase-js'
import type { BotAction } from './bot-output'

// ============================================================
// Deals that move themselves with the AI conversation.
//
// Each bot turn maps the prompt's stage labels to one of three
// automatic stages (new → interested → verify) and creates or advances
// the contact's deal in the pipeline of the program the conversation is
// about (SIMADI, UCAB or Propedéutico — the bot says which with a
// `programa_*` label; otherwise the contact's most recent deal decides,
// and SIMADI is the default). Deals only move forward, and only while
// they sit in an automatic stage or the "lost" one: a deal the owner
// moved to any other stage (e.g. "purchase completed") is never touched
// again. A sweep moves deals whose customer has been silent for
// `lost_after_days` to the lost stage of their pipeline.
// Everything is best-effort — it must never break a reply.
// ============================================================

export type AutoStage = 'new' | 'interested' | 'verify'

const STAGE_RANK: Record<AutoStage, number> = { new: 1, interested: 2, verify: 3 }

/** Prompt label → automatic stage. Unknown labels move nothing. */
const LABEL_STAGE: Record<string, AutoStage> = {
  nuevo_interesado: 'new',
  area_definida: 'interested',
  datos_pago_enviados: 'interested',
  pago_por_verificar: 'verify',
}

/**
 * The programs the business sells, each with its own pipeline. SIMADI is
 * the main one (ai_pipeline_sync); the others live in ai_pipeline_programs
 * (migration 054).
 */
export type Program = 'simadi' | 'ucab' | 'propedeutico'

/** Prompt label → program the conversation is about. */
const LABEL_PROGRAM: Record<string, Program> = {
  programa_simadi: 'simadi',
  programa_ucab: 'ucab',
  programa_propedeutico: 'propedeutico',
}

/** How often the stale-deal sweep may run per account. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000

/** One program's pipeline and the stages the sync moves deals through. */
export interface ProgramPipeline {
  program?: Program
  pipelineId: string | null
  stageNewId: string | null
  stageInterestedId: string | null
  stageVerifyId: string | null
  stageLostId: string | null
  /** Optional: where sales closed through POST /api/v1/sales land. */
  stageWonId: string | null
}

export interface PipelineSyncSettings extends ProgramPipeline {
  enabled: boolean
  lostAfterDays: number
  lastSweepAt: string | null
}

interface SyncRow {
  enabled: boolean
  pipeline_id: string | null
  stage_new_id: string | null
  stage_interested_id: string | null
  stage_verify_id: string | null
  stage_lost_id: string | null
  stage_won_id?: string | null
  lost_after_days: number
  last_sweep_at: string | null
}

export const SYNC_COLUMNS =
  'enabled, pipeline_id, stage_new_id, stage_interested_id, stage_verify_id, stage_lost_id, stage_won_id, lost_after_days, last_sweep_at'

export function rowToSettings(row: SyncRow | null): PipelineSyncSettings {
  return {
    enabled: row?.enabled ?? false,
    pipelineId: row?.pipeline_id ?? null,
    stageNewId: row?.stage_new_id ?? null,
    stageInterestedId: row?.stage_interested_id ?? null,
    stageVerifyId: row?.stage_verify_id ?? null,
    stageLostId: row?.stage_lost_id ?? null,
    stageWonId: row?.stage_won_id ?? null,
    lostAfterDays: row?.lost_after_days ?? 20,
    lastSweepAt: row?.last_sweep_at ?? null,
  }
}

/** True when every id the sync needs is set (a stage deleted → off). */
export function isUsable(s: PipelineSyncSettings): boolean {
  return Boolean(s.enabled && hasAllStages(s))
}

function hasAllStages(p: ProgramPipeline): boolean {
  return Boolean(p.pipelineId && p.stageNewId && p.stageInterestedId && p.stageVerifyId && p.stageLostId)
}

function stageId(s: ProgramPipeline, stage: AutoStage): string {
  return (stage === 'new' ? s.stageNewId : stage === 'interested' ? s.stageInterestedId : s.stageVerifyId)!
}

function autoStageOf(s: ProgramPipeline, id: string): AutoStage | null {
  if (id === s.stageNewId) return 'new'
  if (id === s.stageInterestedId) return 'interested'
  if (id === s.stageVerifyId) return 'verify'
  return null
}

/** The furthest stage this turn's labels/actions point to. */
export function targetStageFromActions(actions: BotAction[]): AutoStage {
  let target: AutoStage = 'new'
  const bump = (s: AutoStage) => {
    if (STAGE_RANK[s] > STAGE_RANK[target]) target = s
  }
  for (const a of actions) {
    if (a.type === 'verify_payment') bump('verify')
    if (a.type === 'label') {
      const mapped = LABEL_STAGE[a.value.trim().toLowerCase()]
      if (mapped) bump(mapped)
    }
  }
  return target
}

/**
 * Where an existing deal should go, or null to leave it alone. Forward
 * moves only; a lost deal whose customer is back is reopened; any stage
 * outside the automatic ones belongs to the owner.
 */
export function decideStageMove(
  s: ProgramPipeline,
  currentStageId: string,
  target: AutoStage,
): string | null {
  if (currentStageId === s.stageLostId) return stageId(s, target)
  const current = autoStageOf(s, currentStageId)
  if (!current) return null
  return STAGE_RANK[target] > STAGE_RANK[current] ? stageId(s, target) : null
}

/** Columns of migration 048 only — read when 051 (stage_won_id) is not applied yet. */
const SYNC_COLUMNS_048 = SYNC_COLUMNS.replace(', stage_won_id', '')

/**
 * Read the account's sync row. Falls back to the pre-051 columns so the
 * deal sync keeps working when the code is deployed before the migration.
 */
export async function selectSyncRow(
  db: SupabaseClient,
  accountId: string,
): Promise<{ data: SyncRow | null; error: unknown }> {
  const read = (columns: string) =>
    db.from('ai_pipeline_sync').select(columns).eq('account_id', accountId).maybeSingle()
  let res = await read(SYNC_COLUMNS)
  if ((res.error as { code?: string } | null)?.code === '42703') res = await read(SYNC_COLUMNS_048)
  return { data: (res.data as SyncRow | null) ?? null, error: res.error }
}

export async function loadPipelineSync(
  db: SupabaseClient,
  accountId: string,
): Promise<PipelineSyncSettings | null> {
  const { data, error } = await selectSyncRow(db, accountId)
  if (error || !data) return null
  return rowToSettings(data)
}

// ---- programs ----------------------------------------------------------

/** The program a turn names: a `programa_*` label, or the REGISTRO's program. */
export function programFromActions(actions: BotAction[]): Program | null {
  let found: Program | null = null
  for (const a of actions) {
    if (a.type === 'label') {
      const p = LABEL_PROGRAM[a.value.trim().toLowerCase()]
      if (p) found = p
    } else if (a.type === 'registro') {
      const p = programFromText(`${a.fields.producto ?? ''} ${a.fields.area ?? ''}`)
      if (p && p !== 'simadi') found = p
    }
  }
  return found
}

/** Program named in free text (a sale note, a REGISTRO field), or null. */
export function programFromText(text: string | null | undefined): Program | null {
  const t = (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  if (!t.trim()) return null
  if (/propedeut/.test(t)) return 'propedeutico'
  if (/\bucab\b/.test(t)) return 'ucab'
  if (/simadi|paquete|guia de estudio|banco de preguntas|simulacro/.test(t)) return 'simadi'
  return null
}

interface ProgramRow {
  program: Program
  pipeline_id: string | null
  stage_new_id: string | null
  stage_interested_id: string | null
  stage_verify_id: string | null
  stage_lost_id: string | null
  stage_won_id: string | null
}

/**
 * Every program's pipeline, SIMADI (the sync row) first. A program whose
 * pipeline or stages were deleted is left out; with `requireStages: false`
 * only the pipeline is needed (closing a sale needs no automatic stage).
 * Before migration 054 this is just SIMADI.
 */
export async function loadProgramPipelines(
  db: SupabaseClient,
  accountId: string,
  settings: PipelineSyncSettings,
  opts: { requireStages?: boolean } = {},
): Promise<ProgramPipeline[]> {
  const requireStages = opts.requireStages ?? true
  const keep = (p: ProgramPipeline) => (requireStages ? hasAllStages(p) : Boolean(p.pipelineId))
  const simadi: ProgramPipeline = {
    program: 'simadi',
    pipelineId: settings.pipelineId,
    stageNewId: settings.stageNewId,
    stageInterestedId: settings.stageInterestedId,
    stageVerifyId: settings.stageVerifyId,
    stageLostId: settings.stageLostId,
    stageWonId: settings.stageWonId,
  }
  const out = keep(simadi) ? [simadi] : []
  const { data, error } = await db
    .from('ai_pipeline_programs')
    .select('program, pipeline_id, stage_new_id, stage_interested_id, stage_verify_id, stage_lost_id, stage_won_id')
    .eq('account_id', accountId)
  if (error) return out
  for (const r of (data ?? []) as ProgramRow[]) {
    const p: ProgramPipeline = {
      program: r.program,
      pipelineId: r.pipeline_id,
      stageNewId: r.stage_new_id,
      stageInterestedId: r.stage_interested_id,
      stageVerifyId: r.stage_verify_id,
      stageLostId: r.stage_lost_id,
      stageWonId: r.stage_won_id,
    }
    if (keep(p) && !out.some((o) => o.pipelineId === p.pipelineId)) out.push(p)
  }
  return out
}

interface DealRef {
  id: string
  stage_id: string
  pipeline_id: string
  notes?: string | null
  created_at?: string | null
  updated_at?: string | null
}

const time = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0)

/**
 * The pipeline a turn (or a sale) belongs to: the program it names, else
 * the one of the contact's most recently touched deal, else the first
 * (SIMADI).
 */
export function pickProgramPipeline(
  programs: ProgramPipeline[],
  named: Program | null,
  deals: DealRef[],
): ProgramPipeline | null {
  if (programs.length === 0) return null
  if (named) {
    const match = programs.find((p) => p.program === named)
    if (match) return match
  }
  const latest = [...deals].sort(
    (a, b) => time(b.updated_at ?? b.created_at) - time(a.updated_at ?? a.created_at),
  )[0]
  return (latest && programs.find((p) => p.pipelineId === latest.pipeline_id)) || programs[0]
}

/** The contact's newest deal in one pipeline (the one the sync moves). */
function newestIn(deals: DealRef[], pipelineId: string): DealRef | undefined {
  return deals
    .filter((d) => d.pipeline_id === pipelineId)
    .sort((a, b) => time(b.created_at) - time(a.created_at))[0]
}

async function contactDeals(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  pipelineIds: string[],
): Promise<DealRef[]> {
  const { data } = await db
    .from('deals')
    .select('id, stage_id, pipeline_id, notes, created_at, updated_at')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .in('pipeline_id', pipelineIds)
  return (data ?? []) as DealRef[]
}

/**
 * Create or advance the contact's deal after a bot turn. `db` is the
 * service role (deals are written outside any user session).
 */
export async function syncDealForTurn(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    configOwnerUserId: string
    actions: BotAction[]
  },
): Promise<void> {
  try {
    const settings = await loadPipelineSync(db, args.accountId)
    if (!settings || !isUsable(settings)) return
    const programs = await loadProgramPipelines(db, args.accountId, settings)
    const target = targetStageFromActions(args.actions)

    const deals = await contactDeals(
      db,
      args.accountId,
      args.contactId,
      programs.map((p) => p.pipelineId!),
    )
    const pipeline = pickProgramPipeline(programs, programFromActions(args.actions), deals)
    if (!pipeline) return
    const deal = newestIn(deals, pipeline.pipelineId!)
    const now = new Date().toISOString()

    if (deal) {
      const next = decideStageMove(pipeline, deal.stage_id, target)
      if (!next || next === deal.stage_id) return
      await db
        .from('deals')
        .update({ stage_id: next, status: 'open', updated_at: now })
        .eq('id', deal.id)
        .eq('account_id', args.accountId)
      return
    }

    const [{ data: contact }, { data: acct }] = await Promise.all([
      db
        .from('contacts')
        .select('name, phone')
        .eq('id', args.contactId)
        .eq('account_id', args.accountId)
        .maybeSingle(),
      db.from('accounts').select('default_currency').eq('id', args.accountId).maybeSingle(),
    ])
    const c = contact as { name: string | null; phone: string | null } | null
    await db.from('deals').insert({
      account_id: args.accountId,
      user_id: args.configOwnerUserId,
      pipeline_id: pipeline.pipelineId,
      stage_id: stageId(pipeline, target),
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      title: c?.name?.trim() || (c?.phone ? `+${c.phone.replace(/^\+/, '')}` : 'Cliente'),
      value: 0,
      currency: (acct as { default_currency?: string } | null)?.default_currency ?? 'USD',
      status: 'open',
    })
  } catch (err) {
    console.error('[pipeline sync] deal update failed:', err)
  }
}

/**
 * Move deals whose customer has been silent for `lost_after_days` to the
 * lost stage of their pipeline. Throttled per account by `last_sweep_at`;
 * call it freely.
 */
export async function sweepStaleDeals(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<number> {
  try {
    const settings = await loadPipelineSync(db, accountId)
    if (!settings || !isUsable(settings)) return 0
    const last = settings.lastSweepAt ? Date.parse(settings.lastSweepAt) : NaN
    if (Number.isFinite(last) && now.getTime() - last < SWEEP_EVERY_MS) return 0
    // Claim the slot first so concurrent webhooks don't all sweep.
    await db
      .from('ai_pipeline_sync')
      .update({ last_sweep_at: now.toISOString() })
      .eq('account_id', accountId)

    const programs = await loadProgramPipelines(db, accountId, settings)
    const lostByPipeline = new Map(programs.map((p) => [p.pipelineId!, p.stageLostId!]))
    const autoStages = programs.flatMap((p) => [p.stageNewId!, p.stageInterestedId!, p.stageVerifyId!])

    const cutoff = new Date(now.getTime() - settings.lostAfterDays * 24 * 60 * 60 * 1000)
    const { data: deals } = await db
      .from('deals')
      .select('id, contact_id, created_at, pipeline_id')
      .eq('account_id', accountId)
      .in('pipeline_id', [...lostByPipeline.keys()])
      .eq('status', 'open')
      .in('stage_id', autoStages)
      .lt('created_at', cutoff.toISOString())
    let moved = 0
    for (const d of (deals ?? []) as { id: string; contact_id: string; created_at: string; pipeline_id: string }[]) {
      const lostStage = lostByPipeline.get(d.pipeline_id)
      if (!lostStage) continue
      const lastCustomerAt = await lastCustomerMessageAt(db, accountId, d.contact_id)
      const reference = lastCustomerAt ?? d.created_at
      if (Date.parse(reference) >= cutoff.getTime()) continue
      await db
        .from('deals')
        .update({ stage_id: lostStage, status: 'lost', updated_at: now.toISOString() })
        .eq('id', d.id)
        .eq('account_id', accountId)
      moved++
    }
    return moved
  } catch (err) {
    console.error('[pipeline sync] stale sweep failed:', err)
    return 0
  }
}

/** When this contact last wrote to us, across all their conversations. */
async function lastCustomerMessageAt(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
  const ids = ((convs ?? []) as { id: string }[]).map((c) => c.id)
  if (ids.length === 0) return null
  const { data: msg } = await db
    .from('messages')
    .select('created_at')
    .in('conversation_id', ids)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  return ((msg ?? []) as { created_at: string }[])[0]?.created_at ?? null
}

/** Stage names that mean "the sale closed" when no won stage is configured. */
const WON_NAME = /compra\s+finalizada|finalizad|ganad|cerrad|\bwon\b|complet/i

/**
 * The stage a closed sale goes to: the configured one, or else a stage of
 * the pipeline whose name reads like "Compra finalizada".
 */
export async function resolveWonStage(
  db: SupabaseClient,
  pipeline: ProgramPipeline,
): Promise<string | null> {
  if (!pipeline.pipelineId) return null
  if (pipeline.stageWonId) return pipeline.stageWonId
  const { data } = await db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', pipeline.pipelineId)
    .order('position', { ascending: true })
  const stages = (data ?? []) as { id: string; name: string }[]
  return stages.find((st) => WON_NAME.test(st.name))?.id ?? null
}

export interface ClosedSaleResult {
  dealId: string
  stageId: string
  created: boolean
}

/**
 * Mark the contact's deal as won in the won stage, with the sale's value
 * in USD; creates the deal when the contact has none in the pipeline.
 * The pipeline is the program's (`program`, e.g. read from the sale's
 * note), else the one of the contact's latest deal, else SIMADI.
 * Returns null when no pipeline / won stage is set up (nothing to move).
 */
export async function closeWonDeal(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    conversationId: string | null
    auditUserId: string
    title: string
    valueUsd: number
    note?: string | null
    program?: Program | null
  },
): Promise<ClosedSaleResult | null> {
  const settings = await loadPipelineSync(db, args.accountId)
  if (!settings?.pipelineId) return null
  const programs = await loadProgramPipelines(db, args.accountId, settings, { requireStages: false })
  const deals = await contactDeals(
    db,
    args.accountId,
    args.contactId,
    programs.map((p) => p.pipelineId!),
  )
  const pipeline = pickProgramPipeline(programs, args.program ?? null, deals)
  if (!pipeline) return null
  const wonStage = await resolveWonStage(db, pipeline)
  if (!wonStage) return null
  const now = new Date().toISOString()
  const deal = newestIn(deals, pipeline.pipelineId!)

  if (deal) {
    const notes = args.note ? [deal.notes?.trim(), args.note].filter(Boolean).join('\n') : deal.notes
    const { error } = await db
      .from('deals')
      .update({
        stage_id: wonStage,
        status: 'won',
        title: args.title,
        value: args.valueUsd,
        currency: 'USD',
        notes,
        updated_at: now,
      })
      .eq('id', deal.id)
      .eq('account_id', args.accountId)
    if (error) throw error
    return { dealId: deal.id, stageId: wonStage, created: false }
  }

  const { data: created, error } = await db
    .from('deals')
    .insert({
      account_id: args.accountId,
      user_id: args.auditUserId,
      pipeline_id: pipeline.pipelineId,
      stage_id: wonStage,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      title: args.title,
      value: args.valueUsd,
      currency: 'USD',
      notes: args.note ?? null,
      status: 'won',
    })
    .select('id')
    .single()
  if (error || !created) throw error ?? new Error('deal insert failed')
  return { dealId: (created as { id: string }).id, stageId: wonStage, created: true }
}

