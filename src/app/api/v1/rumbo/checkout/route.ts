// ============================================================
// Rumbo a la U — local change (see RUMBO.md). Not part of upstream.
//
// POST /api/v1/rumbo/checkout — events from the store's private payment
// page (rumbouni.com/pagar/<token>). Scope: sales:write (the key the
// platform already uses for /api/v1/sales and /payment-alerts).
//
//   { event: 'payment_submitted', kind: 'compra', conversation_id, contact_id, phone,
//     program, fields: {…REGISTRO fields…}, receipt: { mime_type: 'image/jpeg', base64 } }
//     → the SAME «💰 Pago por verificar» Telegram alert the bot raises (with the
//       ✅ Habilitar acceso button and the receipt), and the deal moves to
//       «Pago por verificar». Response: { data: { alert_id } }
//   { event: 'payment_submitted', kind: 'cuota', …, admin_url }
//     → a Telegram text + the receipt («Segundo pago por verificar»); no button
//       (it is not a new sale): the owner marks the payment in the platform.
//   { event: 'checkout_abandoned', conversation_id, phone, name, summary }
//     → a discreet Telegram line with a link to the conversation.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { alertPaymentToVerify } from '@/lib/ai/bot-alerts'
import { syncDealForTurn } from '@/lib/ai/pipeline-sync'
import type { BotAction } from '@/lib/ai/bot-output'
import { isTelegramConfigured, sendTelegramImage, sendTelegramText } from '@/lib/notifications/telegram'
import { properName } from '@/lib/text/proper-name'
import { UUID_RE } from '@/lib/rumbo/conversation'

export const maxDuration = 60

const MAX_RECEIPT_BYTES = 3 * 1024 * 1024
const PROGRAMS = new Set(['simadi', 'ucab', 'propedeutico'])

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Only string fields, at most 20, each ≤ 300 chars. */
function cleanFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 20)) {
    const key = k.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30)
    const value = str(v)
    if (key && value) out[key] = value
  }
  return out
}

function decodeReceipt(raw: unknown): { bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { mime_type?: unknown; base64?: unknown }
  if (r.mime_type !== 'image/jpeg' || typeof r.base64 !== 'string') return null
  const buf = Buffer.from(r.base64, 'base64')
  if (buf.length < 100 || buf.length > MAX_RECEIPT_BYTES) return null
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null   // JPEG magic
  const bytes = new Uint8Array(new ArrayBuffer(buf.length))
  bytes.set(buf)
  return { bytes, mimeType: 'image/jpeg' }
}

function conversationLink(conversationId: string | null): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!conversationId || !site || !/^https?:\/\//.test(site)) return null
  return `${site}/inbox?c=${encodeURIComponent(conversationId)}`
}

const phoneLine = (phone: string): string => {
  const digits = phone.replace(/\D/g, '')
  return digits ? `+${digits}` : ''
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'sales:write')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return fail('bad_request', 'Request body must be a JSON object', 400)
    const event = str(body.event, 40)

    // The conversation must belong to this account (ids come from the platform's own record)
    const conversationId = UUID_RE.test(str(body.conversation_id)) ? str(body.conversation_id) : null
    let target: { accountId: string; conversationId: string; contactId: string } | null = null
    if (conversationId) {
      const { data } = await ctx.supabase.from('conversations').select('id, contact_id').eq('id', conversationId).eq('account_id', ctx.accountId).maybeSingle()
      const row = data as { id: string; contact_id: string } | null
      if (row) target = { accountId: ctx.accountId, conversationId: row.id, contactId: row.contact_id }
    }
    const who = [properName(str(body.name, 120)) || null, phoneLine(str(body.phone, 30)) || null].filter(Boolean).join(' · ') || 'Cliente'
    const link = conversationLink(target?.conversationId ?? null)

    if (event === 'checkout_abandoned') {
      if (isTelegramConfigured()) {
        await sendTelegramText([
          '👀 Salió del pago sin enviar el comprobante',
          `👤 ${who}`,
          str(body.summary) ? `🎯 ${str(body.summary)}` : '',
          'El rescate automático ya está programado (se cancela si escribe, paga o usted le escribe).',
          link ? `🔗 ${link}` : '',
        ].filter(Boolean).join('\n'))
      }
      return ok({ notified: isTelegramConfigured() })
    }

    if (event !== 'payment_submitted') return fail('bad_request', 'Unknown event', 400)
    const fields = cleanFields(body.fields)
    const receipt = decodeReceipt(body.receipt)

    if (str(body.kind, 10) === 'cuota') {
      if (isTelegramConfigured()) {
        const lines = Object.entries(fields).map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)}: ${v}`)
        const adminUrl = /^https:\/\//.test(str(body.admin_url, 400)) ? str(body.admin_url, 400) : ''
        await sendTelegramText([
          '💰 Segundo pago por verificar (enlace de pago)',
          `👤 ${who}`,
          lines.join('\n'),
          'Verifíquelo en su banco y márquelo como pagado en la ficha del estudiante.',
          adminUrl ? `📝 ${adminUrl}` : '',
          link ? `🔗 ${link}` : '',
        ].filter(Boolean).join('\n\n'))
        if (receipt) await sendTelegramImage({ ...receipt, fileName: 'comprobante.jpg', caption: `🧾 Segundo pago · ${who}` })
      }
      return ok({ alert_id: null })
    }

    if (!target) return fail('not_found', 'Conversation not found', 404)
    // The same alert as the bot's REGISTRO (✅ Habilitar acceso), with the page's receipt
    const alertId = await alertPaymentToVerify(ctx.supabase, target, fields, receipt)
    // …and the deal to «Pago por verificar» in the program's pipeline
    const program = str(body.program, 20)
    const actions: BotAction[] = [{ type: 'label', value: 'pago_por_verificar' }]
    if (PROGRAMS.has(program)) actions.push({ type: 'label', value: `programa_${program}` })
    const configOwnerUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId)
    if (configOwnerUserId) await syncDealForTurn(ctx.supabase, { ...target, configOwnerUserId, actions })
    return ok({ alert_id: alertId })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
