import { createHash } from 'node:crypto'

// ============================================================
// Meta Conversions API — the pure part: configuration, hashing and the
// event payloads. Sending and the queue live in capi-queue.ts.
//
// Three ways a customer reaches us from an ad, three payloads:
//   * Click-to-WhatsApp ad: action_source "business_messaging",
//     messaging_channel "whatsapp", user_data { whatsapp_business_account_id,
//     ctwa_clid } — the click id Meta sends with the first message.
//   * Click-to-Instagram-Direct ad: messaging_channel "instagram",
//     user_data { instagram_business_account_id, ig_sid }.
//   * Ad → rumbouni.com → WhatsApp: the website already told Meta about the
//     visit (pixel + server "Contact", with the visit code as external_id);
//     we send the later steps to the website's dataset with
//     action_source "chat", the same external_id and the hashed phone.
// Reference: developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging
// ============================================================

export type CapiChannel = 'whatsapp' | 'instagram' | 'website'

/** What happened, in our words. */
export type CapiStep = 'lead' | 'qualified' | 'checkout' | 'purchase'

/** Meta's event name for each step. The website dataset uses the standard web names. */
export const EVENT_NAMES: Record<CapiChannel, Record<CapiStep, string>> = {
  whatsapp: { lead: 'LeadSubmitted', qualified: 'QualifiedLead', checkout: 'InitiateCheckout', purchase: 'Purchase' },
  instagram: { lead: 'LeadSubmitted', qualified: 'QualifiedLead', checkout: 'InitiateCheckout', purchase: 'Purchase' },
  website: { lead: 'Lead', qualified: 'QualifiedLead', checkout: 'InitiateCheckout', purchase: 'Purchase' },
}

/** Meta refuses an event whose time is more than 7 days old. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_ATTEMPTS = 5

export interface CapiConfig {
  /** META_CAPI_ACTIVO=true: events leave. Off: they wait (and expire after 7 days). */
  active: boolean
  /** Default token, and one per channel when they differ (META_CAPI_TOKEN_WEB: the pixel's own token
   *  from Events Manager, since the WhatsApp app cannot get pixel permissions). */
  token: string | null
  tokens: Record<CapiChannel, string | null>
  apiVersion: string
  datasets: Record<CapiChannel, string | null>
  /** Facebook page id (needed by Meta in some business-messaging payloads). */
  pageId: string | null
  /** Events Manager → Test events code: events show there and are not counted. */
  testCode: string | null
  flushSecret: string | null
}

const env = (name: string) => process.env[name]?.trim() || null

export function capiConfig(): CapiConfig {
  const shared = env('META_CAPI_DATASET')
  return {
    active: env('META_CAPI_ACTIVO') === 'true',
    token: env('META_CAPI_TOKEN'),
    tokens: {
      whatsapp: env('META_CAPI_TOKEN_WHATSAPP') ?? env('META_CAPI_TOKEN'),
      instagram: env('META_CAPI_TOKEN_INSTAGRAM') ?? env('META_CAPI_TOKEN'),
      website: env('META_CAPI_TOKEN_WEB') ?? env('META_CAPI_TOKEN'),
    },
    apiVersion: env('META_CAPI_API_VERSION') ?? 'v27.0',
    datasets: {
      whatsapp: env('META_CAPI_DATASET_WHATSAPP') ?? shared,
      instagram: env('META_CAPI_DATASET_INSTAGRAM') ?? shared,
      website: env('META_PIXEL_ID') ?? shared,
    },
    pageId: env('META_PAGE_ID'),
    testCode: env('META_CAPI_TEST_CODE'),
    flushSecret: env('META_CAPI_FLUSH_SECRET'),
  }
}

/** Ready to send on that channel (token + dataset). */
export const tokenFor = (cfg: CapiConfig, channel: CapiChannel) => cfg.tokens?.[channel] ?? cfg.token
export const canSend = (cfg: CapiConfig, channel: CapiChannel) => Boolean(tokenFor(cfg, channel) && cfg.datasets[channel])

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Phone as Meta wants it before hashing: digits only, with the country code. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '').replace(/^00/, '')
  if (digits.length < 8) return null
  // A Venezuelan number saved without the country code (0412…)
  if (digits.startsWith('0') && digits.length === 11) return `58${digits.slice(1)}`
  return digits
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = String(email ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

/** Who the event is about, as each channel identifies people. */
export type CapiIdentity =
  | { channel: 'whatsapp'; wabaId: string; ctwaClid: string }
  | { channel: 'instagram'; igAccountId: string; igsid: string }
  | { channel: 'website'; visitCode: string; phone: string | null; email: string | null }

export interface CapiEventInput {
  eventId: string
  step: CapiStep
  occurredAt: Date
  identity: CapiIdentity
  valueUsd?: number | null
  /** Program, as content_category (simadi | ucab | propedeutico). */
  program?: string | null
}

/** One element of the `data` array of POST /{dataset}/events. */
export function buildEvent(input: CapiEventInput, cfg: Pick<CapiConfig, 'pageId'>): Record<string, unknown> {
  const { identity } = input
  const event: Record<string, unknown> = {
    event_name: EVENT_NAMES[identity.channel][input.step],
    event_time: Math.floor(input.occurredAt.getTime() / 1000),
    event_id: input.eventId,
  }

  if (identity.channel === 'whatsapp') {
    event.action_source = 'business_messaging'
    event.messaging_channel = 'whatsapp'
    event.user_data = {
      whatsapp_business_account_id: identity.wabaId,
      ctwa_clid: identity.ctwaClid,
      ...(cfg.pageId ? { page_id: cfg.pageId } : {}),
    }
  } else if (identity.channel === 'instagram') {
    event.action_source = 'business_messaging'
    event.messaging_channel = 'instagram'
    event.user_data = { instagram_business_account_id: identity.igAccountId, ig_sid: identity.igsid }
  } else {
    event.action_source = 'chat'
    const phone = normalizePhone(identity.phone)
    const email = normalizeEmail(identity.email)
    event.user_data = {
      external_id: [sha256(identity.visitCode)],
      ...(phone ? { ph: [sha256(phone)] } : {}),
      ...(email ? { em: [sha256(email)] } : {}),
      country: [sha256('ve')],
    }
  }

  const custom: Record<string, unknown> = {}
  if (input.valueUsd != null && input.valueUsd > 0) {
    custom.currency = 'USD'
    custom.value = Math.round(input.valueUsd * 100) / 100
  }
  if (input.program) custom.content_category = input.program
  if (Object.keys(custom).length) event.custom_data = custom
  return event
}

export interface SendResult {
  ok: boolean
  /** Meta's reply, or the network error, short. */
  detail: string
}

type Fetcher = typeof fetch

/** POST one event to a dataset. Never throws. */
export async function sendEvent(
  cfg: CapiConfig,
  channel: CapiChannel,
  event: Record<string, unknown>,
  opts: { test?: boolean; fetcher?: Fetcher } = {},
): Promise<SendResult> {
  const dataset = cfg.datasets[channel]
  const token = tokenFor(cfg, channel)
  if (!token || !dataset) return { ok: false, detail: 'Falta el token o el dataset de Meta' }
  const body: Record<string, unknown> = { data: [event] }
  const testCode = opts.test ? cfg.testCode : null
  if (testCode) body.test_event_code = testCode
  try {
    const res = await (opts.fetcher ?? fetch)(
      `https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(dataset)}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    )
    const json = (await res.json().catch(() => null)) as
      | { events_received?: number; error?: { message?: string; error_user_msg?: string } }
      | null
    if (res.ok && (json?.events_received ?? 0) >= 1) return { ok: true, detail: `events_received ${json?.events_received}` }
    const msg = json?.error?.error_user_msg ?? json?.error?.message ?? `HTTP ${res.status}`
    return { ok: false, detail: msg.slice(0, 300) }
  } catch (err) {
    return { ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) }
  }
}
