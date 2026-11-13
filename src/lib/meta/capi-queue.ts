import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPipelineSync, loadProgramPipelines, resolveWonStage, type Program } from '@/lib/ai/pipeline-sync'
import {
  buildEvent,
  canSend,
  MAX_ATTEMPTS,
  MAX_EVENT_AGE_MS,
  sendEvent,
  EVENT_NAMES,
  type CapiConfig,
  type CapiIdentity,
  type CapiStep,
} from './capi'

// ============================================================
// The outbox of migration 075 (capi_events): turn each queued row into a
// Meta event, send it and record what happened.
//
//   * A stage row becomes an event only for the automatic stages that
//     mean something to an advertiser: Interesado → QualifiedLead,
//     Pago por verificar → InitiateCheckout, Compra finalizada → Purchase
//     (with the deal's value in USD; a sale with no value waits until it
//     has one). «Nuevo», «Muerto», hand-made stages and the «Colegios»
//     pipeline are skipped.
//   * An arrival row (lead_sources 'anuncio_*') becomes LeadSubmitted.
//   * Only contacts that came from an ad are reported: the identity is the
//     ad's click id (WhatsApp), the Instagram id (Instagram) or the website
//     visit code (web ad). Others are skipped — Meta has nothing to match.
//   * One sent event per deal and name; up to 5 attempts; rows older than
//     7 days expire. Two flushes at once cannot send a row twice: each row
//     is claimed by bumping `attempts` first.
// ============================================================

export interface CapiRow {
  id: string
  account_id: string
  contact_id: string | null
  deal_id: string | null
  stage_event_id: string | null
  lead_source_id: string | null
  pipeline_id: string | null
  stage_id: string | null
  occurred_at: string
  status: string
  attempts: number
}

interface TouchRow {
  id: string
  channel: string
  source: string
  click_id: string | null
  ad_id: string | null
  visit_code?: string | null
  created_at: string
}

export interface FlushSummary {
  sent: number
  skipped: number
  failed: number
  expired: number
  waiting: number
}

const AD_SOURCES = ['anuncio_instagram', 'anuncio_facebook', 'anuncio_meta']

type StageKind = { step: CapiStep | null; program: Program | null }

/** stage id → step, for every program pipeline of the account. */
async function stageMap(db: SupabaseClient, accountId: string): Promise<Map<string, StageKind>> {
  const map = new Map<string, StageKind>()
  const settings = await loadPipelineSync(db, accountId)
  if (!settings) return map
  const programs = await loadProgramPipelines(db, accountId, settings, { requireStages: false })
  for (const p of programs) {
    const program = p.program ?? null
    // B2B schools are not ad leads
    const step = (s: CapiStep) => (program === 'colegio' ? null : s)
    if (p.stageInterestedId) map.set(p.stageInterestedId, { step: step('qualified'), program })
    if (p.stageVerifyId) map.set(p.stageVerifyId, { step: step('checkout'), program })
    const won = await resolveWonStage(db, p)
    if (won) map.set(won, { step: step('purchase'), program })
  }
  return map
}

/** The ad arrival that identifies a contact: the latest one up to the event. */
export function pickTouch(touches: TouchRow[], at: Date): TouchRow | null {
  const before = touches
    .filter((t) => t.source.startsWith('anuncio_') && Date.parse(t.created_at) <= at.getTime() + 60_000)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  return (
    before.find((t) => t.channel === 'whatsapp' && t.click_id) ??
    before.find((t) => t.channel === 'instagram') ??
    before.find((t) => t.visit_code) ??
    null
  )
}

interface Ids {
  wabaId: string | null
  igAccountId: string | null
}

async function accountIds(db: SupabaseClient, accountId: string): Promise<Ids> {
  const [wa, ig] = await Promise.all([
    db.from('whatsapp_config').select('waba_id').eq('account_id', accountId).limit(1).maybeSingle(),
    db.from('instagram_config').select('ig_account_id').eq('account_id', accountId).limit(1).maybeSingle(),
  ])
  return {
    wabaId: process.env.META_WABA_ID?.trim() || ((wa.data as { waba_id?: string } | null)?.waba_id ?? null),
    igAccountId:
      process.env.META_IG_ACCOUNT_ID?.trim() || ((ig.data as { ig_account_id?: string } | null)?.ig_account_id ?? null),
  }
}

type Outcome =
  | { kind: 'send'; channel: CapiIdentity['channel']; event: Record<string, unknown>; eventName: string; valueUsd: number | null }
  | { kind: 'skip'; reason: string; eventName?: string }
  | { kind: 'wait'; reason: string; eventName?: string; channel?: CapiIdentity['channel'] }

/** Decide what one row becomes. Reads, never writes. */
export async function resolveRow(
  db: SupabaseClient,
  row: CapiRow,
  ctx: { cfg: CapiConfig; stages: Map<string, StageKind>; ids: Ids },
): Promise<Outcome> {
  if (!row.contact_id) return { kind: 'skip', reason: 'Sin contacto' }

  let step: CapiStep
  let program: Program | null = null
  if (row.lead_source_id) {
    step = 'lead'
  } else {
    const kind = row.stage_id ? ctx.stages.get(row.stage_id) : undefined
    if (!kind?.step) return { kind: 'skip', reason: 'Etapa sin evento para Meta' }
    step = kind.step
    program = kind.program
  }

  const { data: touchData } = await db
    .from('lead_sources')
    .select('id, channel, source, click_id, ad_id, visit_code, created_at')
    .eq('contact_id', row.contact_id)
    .in('source', AD_SOURCES)
    .order('created_at', { ascending: false })
    .limit(20)
  let touches = (touchData ?? []) as TouchRow[]
  // The arrival itself decides a LeadSubmitted
  if (row.lead_source_id) touches = touches.filter((t) => t.id === row.lead_source_id)
  const occurred = new Date(row.occurred_at)
  const touch = pickTouch(touches, occurred)
  if (!touch) return { kind: 'skip', reason: 'No llegó por un anuncio' }

  let identity: CapiIdentity | null = null
  if (touch.channel === 'whatsapp' && touch.click_id) {
    if (!ctx.ids.wabaId) return { kind: 'wait', reason: 'Falta el ID de la cuenta de WhatsApp Business' }
    identity = { channel: 'whatsapp', wabaId: ctx.ids.wabaId, ctwaClid: touch.click_id }
  } else if (touch.channel === 'instagram') {
    const { data: c } = await db.from('contacts').select('ig_user_id').eq('id', row.contact_id).maybeSingle()
    const igsid = (c as { ig_user_id?: string | null } | null)?.ig_user_id
    if (!igsid) return { kind: 'skip', reason: 'El contacto no tiene ID de Instagram' }
    if (!ctx.ids.igAccountId) return { kind: 'wait', reason: 'Falta el ID de la cuenta de Instagram' }
    identity = { channel: 'instagram', igAccountId: ctx.ids.igAccountId, igsid }
  } else if (touch.visit_code) {
    const { data: c } = await db.from('contacts').select('phone, email').eq('id', row.contact_id).maybeSingle()
    const contact = (c ?? {}) as { phone?: string | null; email?: string | null }
    identity = { channel: 'website', visitCode: touch.visit_code, phone: contact.phone ?? null, email: contact.email ?? null }
  }
  if (!identity) return { kind: 'skip', reason: 'No llegó por un anuncio' }

  const eventName = EVENT_NAMES[identity.channel][step]

  // Reported once per deal
  if (row.deal_id) {
    const { data: dup } = await db
      .from('capi_events')
      .select('id')
      .eq('deal_id', row.deal_id)
      .eq('event_name', eventName)
      .eq('status', 'sent')
      .eq('test_mode', Boolean(ctx.cfg.testCode))
      .neq('id', row.id)
      .limit(1)
    if ((dup ?? []).length) return { kind: 'skip', reason: 'Ya enviado para esta tarjeta', eventName }
  }

  let valueUsd: number | null = null
  if (step === 'purchase' || step === 'checkout') {
    if (row.deal_id) {
      const { data: d } = await db.from('deals').select('value, currency').eq('id', row.deal_id).maybeSingle()
      const deal = (d ?? {}) as { value?: number | string | null; currency?: string | null }
      const v = Number(deal.value)
      if (Number.isFinite(v) && v > 0 && (deal.currency ?? 'USD').toUpperCase() === 'USD') valueUsd = v
    }
    if (step === 'purchase' && valueUsd == null) {
      return { kind: 'wait', reason: 'La compra no tiene monto en USD en la tarjeta', eventName, channel: identity.channel }
    }
  }

  if (!canSend(ctx.cfg, identity.channel)) {
    return { kind: 'wait', reason: 'Falta el token o el dataset de este canal', eventName, channel: identity.channel }
  }

  const event = buildEvent(
    { eventId: row.id, step, occurredAt: occurred, identity, valueUsd, program },
    ctx.cfg,
  )
  return { kind: 'send', channel: identity.channel, event, eventName, valueUsd }
}

/** Process the pending rows of every account. Never throws. */
export async function flushCapiQueue(
  db: SupabaseClient,
  cfg: CapiConfig,
  opts: { limit?: number; now?: Date; fetcher?: typeof fetch } = {},
): Promise<FlushSummary> {
  const summary: FlushSummary = { sent: 0, skipped: 0, failed: 0, expired: 0, waiting: 0 }
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()

  // Too old for Meta: expire, whatever the switch says
  const cutoff = new Date(now.getTime() - MAX_EVENT_AGE_MS + 10 * 60_000).toISOString()
  const { data: old } = await db
    .from('capi_events')
    .update({ status: 'expired', reason: 'Más de 7 días: Meta ya no lo acepta', updated_at: nowIso })
    .in('status', ['pending', 'error'])
    .lt('occurred_at', cutoff)
    .select('id')
  summary.expired = (old ?? []).length

  if (!cfg.active) return summary

  const { data, error } = await db
    .from('capi_events')
    .select('id, account_id, contact_id, deal_id, stage_event_id, lead_source_id, pipeline_id, stage_id, occurred_at, status, attempts')
    .in('status', ['pending', 'error'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('occurred_at', { ascending: true })
    .limit(opts.limit ?? 100)
  if (error) {
    console.error('[capi] queue read failed:', error.message)
    return summary
  }

  const perAccount = new Map<string, { stages: Map<string, StageKind>; ids: Ids }>()
  for (const row of (data ?? []) as CapiRow[]) {
    try {
      let ctx = perAccount.get(row.account_id)
      if (!ctx) {
        ctx = { stages: await stageMap(db, row.account_id), ids: await accountIds(db, row.account_id) }
        perAccount.set(row.account_id, ctx)
      }
      const outcome = await resolveRow(db, row, { cfg, ...ctx })

      if (outcome.kind === 'skip') {
        await db
          .from('capi_events')
          .update({ status: 'skipped', reason: outcome.reason, event_name: outcome.eventName ?? null, updated_at: nowIso })
          .eq('id', row.id)
        summary.skipped++
        continue
      }
      if (outcome.kind === 'wait') {
        await db
          .from('capi_events')
          .update({ reason: outcome.reason, event_name: outcome.eventName ?? null, channel: outcome.channel ?? null, updated_at: nowIso })
          .eq('id', row.id)
        summary.waiting++
        continue
      }

      // Claim the row: whoever bumps `attempts` first sends it
      const { data: claimed } = await db
        .from('capi_events')
        .update({ attempts: row.attempts + 1, updated_at: nowIso })
        .eq('id', row.id)
        .eq('attempts', row.attempts)
        .in('status', ['pending', 'error'])
        .select('id')
      if (!(claimed ?? []).length) continue

      const test = Boolean(cfg.testCode)
      const result = await sendEvent(cfg, outcome.channel, outcome.event, { test, fetcher: opts.fetcher })
      const { error: saveError } = await db
        .from('capi_events')
        .update({
          status: result.ok ? 'sent' : 'error',
          reason: result.ok ? null : result.detail,
          event_name: outcome.eventName,
          channel: outcome.channel,
          value_usd: outcome.valueUsd,
          meta_event_id: row.id,
          test_mode: test,
          sent_at: result.ok ? nowIso : null,
          updated_at: nowIso,
        })
        .eq('id', row.id)
      if (saveError) console.error('[capi] save failed:', saveError.message)
      if (result.ok) summary.sent++
      else summary.failed++
    } catch (err) {
      console.error('[capi] row failed:', err)
      summary.failed++
    }
  }
  return summary
}
