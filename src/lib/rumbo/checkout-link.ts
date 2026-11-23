// ============================================================
// Rumbo a la U — local change (see RUMBO.md). Not part of upstream.
//
// Two control lines the Rumbo bot prompt may write (never shown to the
// customer: parseBotOutput strips every `[[…]]` line):
//
//   [[PEDIDO|programa=…|producto=…|plan=…|area=…]]  + `{{ENLACE_PAGO}}`
//     → ask the store's platform for a private payment link and put it
//       in the reply before it is sent. `{{ENLACE_PAGO_VENCE}}` becomes
//       "viernes 20 de noviembre" (how long the link is valid).
//   [[ENVIAR:corto_simadi]]
//     → after the reply, ask the platform to send that clip / fixed
//       voice note to this conversation (the platform owns the
//       "one voice note per conversation" budget).
//
// Platform: RUMBO_PLATFORM_URL (default https://rumbouni.com), shared
// secret RUMBO_CHECKOUT_SECRET (= the platform's CHECKOUT_SECRETO).
// Without the secret nothing is called and the placeholder line is
// replaced by a polite fallback. Everything is best-effort: it never
// breaks a reply.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { platformUrl } from '@/lib/ai/payment-alerts'
import { sendTelegramText, isTelegramConfigured } from '@/lib/notifications/telegram'
import { conversationSchoolRef } from '@/lib/leads/school-ref'

export const LINK_PLACEHOLDER = '{{ENLACE_PAGO}}'
export const VALID_UNTIL_PLACEHOLDER = '{{ENLACE_PAGO_VENCE}}'
export const LINK_FALLBACK = 'En un momento le envío el enlace para el pago 🙏'
const PEDIDO_RE = /\[\[\s*PEDIDO\s*\|([^\]]*)\]\]/i
const ENVIAR_RE = /\[\[\s*ENVIAR\s*:\s*([a-z_]{3,30})\s*\]\]/gi

interface Target {
  accountId: string
  conversationId: string
  contactId: string
}

/** `[[PEDIDO|programa=SIMADI|plan=2 partes]]` → { programa: 'SIMADI', plan: '2 partes' } (null if absent). */
export function parsePedido(raw: string): Record<string, string> | null {
  const m = (raw ?? '').match(PEDIDO_RE)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const part of m[1].split('|')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim().slice(0, 80)
    if (key && value) fields[key] = value
  }
  return fields
}

/** Keys of `[[ENVIAR:…]]` lines, in order, without repeats (at most 2 per turn). */
export function requestedMedia(raw: string): string[] {
  const keys = [...(raw ?? '').matchAll(ENVIAR_RE)].map((m) => m[1].toLowerCase())
  return [...new Set(keys)].slice(0, 2)
}

/** The link lines added when the bot wrote the order but forgot `{{ENLACE_PAGO}}` (RUMBO.md, cambio 11). */
export const LINK_BLOCK = `👇 *Su enlace de pago privado:*\n${LINK_PLACEHOLDER}\n🔒 El enlace es solo para usted y vale hasta el *${VALID_UNTIL_PLACEHOLDER}*.`

/**
 * Safety net (22-nov: the bot answered «Le preparo su enlace…», wrote the
 * order line and no placeholder, so no link was ever created): with an
 * order and no placeholder, the link goes in a message of its own at the end.
 */
export function ensureLinkSlot(raw: string, parts: string[]): string[] {
  if (parts.some((p) => p.includes(LINK_PLACEHOLDER))) return parts
  if (!parsePedido(raw)) return parts
  return [...parts, LINK_BLOCK]
}

/** Replace the placeholders; when there is no link, the whole line that held it becomes the fallback. */
export function fillLink(parts: string[], link: { url: string; validUntil: string } | null): string[] {
  return parts.map((part) => {
    if (!part.includes(LINK_PLACEHOLDER) && !part.includes(VALID_UNTIL_PLACEHOLDER)) return part
    if (link) return part.split(LINK_PLACEHOLDER).join(link.url).split(VALID_UNTIL_PLACEHOLDER).join(link.validUntil)
    const lines = part.split('\n').map((l) => (l.includes(LINK_PLACEHOLDER) ? LINK_FALLBACK : l))
    return lines.filter((l) => !l.includes(VALID_UNTIL_PLACEHOLDER)).join('\n')
  })
}

function secret(): string | null {
  const s = process.env.RUMBO_CHECKOUT_SECRET?.trim()
  return s && s.length >= 32 ? s : null
}

async function callPlatform(path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const key = secret()
  if (!key) return { ok: false, status: 0, data: null }
  try {
    const res = await fetch(`${platformUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    console.warn(`[rumbo] ${path} failed:`, err)
    return { ok: false, status: 0, data: null }
  }
}

async function contactOf(db: SupabaseClient, target: Target): Promise<{ phone: string | null; name: string | null }> {
  const { data } = await db.from('contacts').select('phone, name').eq('id', target.contactId).eq('account_id', target.accountId).maybeSingle()
  const row = data as { phone: string | null; name: string | null } | null
  const digits = String(row?.phone ?? '').replace(/\D/g, '')
  return { phone: digits.length >= 8 ? `+${digits}` : null, name: row?.name ?? null }
}

/**
 * If this turn's reply carries `{{ENLACE_PAGO}}`, create the link on the
 * platform and put it in. Returns the parts to send.
 */
export async function withCheckoutLink(
  db: SupabaseClient,
  target: Target,
  raw: string,
  parts: string[],
  channel: string | null,
): Promise<string[]> {
  parts = ensureLinkSlot(raw, parts)
  if (!parts.some((p) => p.includes(LINK_PLACEHOLDER) || p.includes(VALID_UNTIL_PLACEHOLDER))) return parts
  try {
    const pedido = parsePedido(raw) ?? {}
    const contact = await contactOf(db, target)
    // Allied school (RUMBO.md, cambio 13): the invisible code of the school link, read from the customer's first
    // messages. The platform checks it and charges the plan A price (10 % off); an unknown code changes nothing.
    const colegio = await conversationSchoolRef(db, target.conversationId)
    const r = await callPlatform('/api/crm/checkout', {
      ...pedido,
      ...(colegio ? { colegio } : {}),
      phone: contact.phone,
      name: contact.name,
      contact_id: target.contactId,
      conversation_id: target.conversationId,
      channel: channel === 'instagram' ? 'instagram' : 'whatsapp',
    }, 8_000)
    const url = typeof r.data?.url === 'string' ? r.data.url : null
    const validUntil = typeof r.data?.vence_texto === 'string' ? r.data.vence_texto : ''
    if (r.ok && url) return fillLink(parts, { url, validUntil })
    console.warn(`[rumbo] payment link not created (${r.status})`)
    if (isTelegramConfigured()) {
      await sendTelegramText(`⚠️ No se pudo crear el enlace de pago (${r.status || 'sin respuesta'}).\n👤 ${contact.name ?? ''} ${contact.phone ?? ''}\nEl bot le dijo que se lo envía en un momento: envíeselo usted.`)
    }
  } catch (err) {
    console.warn('[rumbo] payment link failed:', err)
  }
  return fillLink(parts, null)
}

/** After the reply: ask the platform to send the requested clip / fixed voice note. */
export async function sendRequestedMedia(db: SupabaseClient, target: Target, raw: string, channel: string | null): Promise<void> {
  const keys = requestedMedia(raw)
  if (!keys.length) return
  try {
    const contact = await contactOf(db, target)
    for (const key of keys) {
      await callPlatform('/api/crm/medio', {
        clave: key,
        phone: contact.phone,
        name: contact.name,
        contact_id: target.contactId,
        conversation_id: target.conversationId,
        channel: channel === 'instagram' ? 'instagram' : 'whatsapp',
      }, 20_000)
    }
  } catch (err) {
    console.warn('[rumbo] media request failed:', err)
  }
}
