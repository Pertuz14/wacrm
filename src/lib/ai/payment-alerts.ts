import type { SupabaseClient } from '@supabase/supabase-js'
import {
  editTelegramText,
  telegramOwnerChatId,
  type SentMessage,
  type TelegramButton,
} from '@/lib/notifications/telegram'

// ============================================================
// One-tap "enable access" for payment alerts (see migration 052).
//
// The store's platform (Rumbo a la U, RUMBO_PLATFORM_URL, default
// https://rumbouni.com) turns the customer's registration into a sale:
//   POST {platform}/api/crm/vista-previa              → what would be registered
//   POST {platform}/api/crm/alertas-pago/{id}/registrar → register an approved alert
// The platform never trusts data sent to it for writes: it pulls the
// alert from /api/v1/payment-alerts/{id} with its own API key.
// ============================================================

export interface PaymentAlertRow {
  id: string
  account_id: string
  status: 'pending' | 'approved' | 'processing' | 'done'
  fields: Record<string, string>
  phone: string | null
  message_text: string | null
  telegram: SentMessage[] | null
  summary: string | null
  error: string | null
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function platformUrl(): string {
  return (process.env.RUMBO_PLATFORM_URL?.trim() || 'https://rumbouni.com').replace(/\/+$/, '')
}

/** Callback data of the "enable access" button. */
export const approveData = (id: string) => `pa:${id}`
export const APPROVE_RE = /^pa:([0-9a-f-]{36})$/i

export function alertButtons(id: string, withApprove: boolean): TelegramButton[] {
  const form: TelegramButton = {
    text: '📝 Revisar en el formulario',
    url: `${platformUrl()}/admin/accesos?alerta=${encodeURIComponent(id)}`,
  }
  return withApprove ? [{ text: '✅ Habilitar acceso', callback_data: approveData(id) }, form] : [form]
}

export interface RegistrationPreview {
  listo: boolean
  faltan: string[]
  resumen: string
}

/** What the platform would register; null when it can't be reached. */
export async function previewRegistration(
  fields: Record<string, string>,
  phone: string | null,
): Promise<RegistrationPreview | null> {
  try {
    const res = await fetch(`${platformUrl()}/api/crm/vista-previa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, phone }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await res.json().catch(() => null)) as RegistrationPreview | null
    if (!res.ok || !data || typeof data.resumen !== 'string') return null
    return { listo: data.listo === true, faltan: Array.isArray(data.faltan) ? data.faltan : [], resumen: data.resumen }
  } catch (err) {
    console.warn('[payment alerts] preview failed:', err)
    return null
  }
}

/** Ask the platform to register an approved alert (it pulls the data itself). */
export async function requestRegistration(id: string): Promise<void> {
  try {
    await fetch(`${platformUrl()}/api/crm/alertas-pago/${encodeURIComponent(id)}/registrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    console.warn('[payment alerts] registration request failed:', err)
  }
}

export async function loadAlert(
  db: SupabaseClient,
  id: string,
  accountId?: string,
): Promise<PaymentAlertRow | null> {
  if (!UUID_RE.test(id)) return null
  let q = db.from('payment_alerts').select('*').eq('id', id)
  if (accountId) q = q.eq('account_id', accountId)
  const { data } = await q.maybeSingle()
  return (data as PaymentAlertRow | null) ?? null
}

/** Show the outcome under the original alert, in every chat it was sent to. */
export async function showOnTelegram(
  row: PaymentAlertRow,
  footer: string,
  buttons?: TelegramButton[],
): Promise<void> {
  const base = row.message_text ?? '💰 Pago por verificar'
  const owner = telegramOwnerChatId()
  for (const message of row.telegram ?? []) {
    // Only the owner's copy carries buttons
    const isOwnerCopy = String(message.chat_id) === owner
    const r = await editTelegramText(message, `${base}\n\n${footer}`, isOwnerCopy ? buttons : undefined)
    if (!r.ok) console.warn('[payment alerts] could not edit the Telegram alert:', r.error)
  }
}

/**
 * Close an alert: registered (done) or back to pending with the error,
 * and say so on Telegram.
 */
export async function finishAlert(
  db: SupabaseClient,
  row: PaymentAlertRow,
  outcome: { ok: boolean; summary?: string | null; error?: string | null },
): Promise<PaymentAlertRow> {
  const now = new Date().toISOString()
  const patch = outcome.ok
    ? { status: 'done', summary: outcome.summary?.slice(0, 2000) || null, error: null, updated_at: now }
    : { status: 'pending', error: outcome.error?.slice(0, 1000) || 'Error desconocido', updated_at: now }
  const { data } = await db.from('payment_alerts').update(patch).eq('id', row.id).select('*').maybeSingle()
  const updated = (data as PaymentAlertRow | null) ?? { ...row, ...patch } as PaymentAlertRow
  if (outcome.ok) {
    await showOnTelegram(updated, `✅ Acceso habilitado\n${updated.summary ?? ''}`.trim())
  } else {
    await showOnTelegram(updated, `⚠️ No se registró: ${updated.error}`, alertButtons(row.id, true))
  }
  return updated
}
