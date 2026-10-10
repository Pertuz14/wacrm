import type { SupabaseClient } from '@supabase/supabase-js'
import type { BotAction } from './bot-output'

// ============================================================
// Deals that move themselves with the AI conversation.
//
// Each bot turn maps the prompt's stage labels to one of three
// automatic stages (new → interested → verify) and creates or advances
// the contact's deal in the configured pipeline. Deals only move
// forward, and only while they sit in an automatic stage or the "lost"
// one: a deal the owner moved to any other stage (e.g. "purchase
// completed") is never touched again. A sweep moves deals whose
// customer has been silent for `lost_after_days` to the lost stage.
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

/** How often the stale-deal sweep may run per account. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000

export interface PipelineSyncSettings {
  enabled: boolean
  pipelineId: string | null
  stageNewId: string | null
  stageInterestedId: string | null
  stageVerifyId: string | null
  stageLostId: string | null
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
  lost_after_days: number
  last_sweep_at: string | null
}

export const SYNC_COLUMNS =
  'enabled, pipeline_id, stage_new_id, stage_interested_id, stage_verify_id, stage_lost_id, lost_after_days, last_sweep_at'

export function rowToSettings(row: SyncRow | null): PipelineSyncSettings {
  return {
    enabled: row?.enabled ?? false,
    pipelineId: row?.pipeline_id ?? null,
    stageNewId: row?.stage_new_id ?? null,
    stageInterestedId: row?.stage_interested_id ?? null,
    stageVerifyId: row?.stage_verify_id ?? null,
    stageLostId: row?.stage_lost_id ?? null,
    lostAfterDays: row?.lost_after_days ?? 20,
    lastSweepAt: row?.last_sweep_at ?? null,
  }
}

/** True when every id the sync needs is set (a stage deleted → off). */
export function isUsable(s: PipelineSyncSettings): boolean {
  return Boolean(
    s.enabled &&
      s.pipelineId &&
      s.stageNewId &&
      s.stageInterestedId &&
      s.stageVerifyId &&
      s.stageLostId,
  )
}

function stageId(s: PipelineSyncSettings, stage: AutoStage): string {
  return (stage === 'new' ? s.stageNewId : stage === 'interested' ? s.stageInterestedId : s.stageVerifyId)!
}

function autoStageOf(s: PipelineSyncSettings, id: string): AutoStage | null {
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
  s: PipelineSyncSettings,
  currentStageId: string,
  target: AutoStage,
): string | null {
  if (currentStageId === s.stageLostId) return stageId(s, target)
  const current = autoStageOf(s, currentStageId)
  if (!current) return null
  return STAGE_RANK[target] > STAGE_RANK[current] ? stageId(s, target) : null
}

export async function loadPipelineSync(
  db: SupabaseClient,
  accountId: string,
): Promise<PipelineSyncSettings | null> {
  const { data, error } = await db
    .from('ai_pipeline_sync')
    .select(SYNC_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  return rowToSettings(data as SyncRow)
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
    const target = targetStageFromActions(args.actions)

    const { data: existing } = await db
      .from('deals')
      .select('id, stage_id')
      .eq('account_id', args.accountId)
      .eq('pipeline_id', settings.pipelineId!)
      .eq('contact_id', args.contactId)
      .order('created_at', { ascending: false })
      .limit(1)
    const deal = (existing as { id: string; stage_id: string }[] | null)?.[0]
    const now = new Date().toISOString()

    if (deal) {
      const next = decideStageMove(settings, deal.stage_id, target)
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
      pipeline_id: settings.pipelineId,
      stage_id: stageId(settings, target),
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
 * lost stage. Throttled per account by `last_sweep_at`; call it freely.
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

    const cutoff = new Date(now.getTime() - settings.lostAfterDays * 24 * 60 * 60 * 1000)
    const { data: deals } = await db
      .from('deals')
      .select('id, contact_id, created_at')
      .eq('account_id', accountId)
      .eq('pipeline_id', settings.pipelineId!)
      .eq('status', 'open')
      .in('stage_id', [settings.stageNewId!, settings.stageInterestedId!, settings.stageVerifyId!])
      .lt('created_at', cutoff.toISOString())
    let moved = 0
    for (const d of (deals ?? []) as { id: string; contact_id: string; created_at: string }[]) {
      const lastCustomerAt = await lastCustomerMessageAt(db, accountId, d.contact_id)
      const reference = lastCustomerAt ?? d.created_at
      if (Date.parse(reference) >= cutoff.getTime()) continue
      await db
        .from('deals')
        .update({ stage_id: settings.stageLostId, status: 'lost', updated_at: now.toISOString() })
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
