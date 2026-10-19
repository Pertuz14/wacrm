import type { supabaseAdmin } from './admin-client'
import { loadAccountMetaCredentials } from '@/lib/flows/meta-send'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import {
  isTelegramConfigured,
  sendTelegramImage,
  sendTelegramText,
} from '@/lib/notifications/telegram'

// ============================================================
// Alerts the assistant raises to the business owner (over Telegram):
//   - a customer sent a payment receipt + registration to verify
//   - a conversation was handed off to a human
// Best-effort throughout: errors are logged, never thrown.
// ============================================================

type Db = ReturnType<typeof supabaseAdmin>

/** How far back to look for the receipt image / registration text. */
const LOOKBACK_MS = 6 * 60 * 60 * 1000
const PROXY_MEDIA_PREFIX = '/api/whatsapp/media/'

interface AlertTarget {
  accountId: string
  conversationId: string
  contactId: string
}

interface ContactInfo {
  name: string | null
  phone: string | null
}

async function loadContact(db: Db, target: AlertTarget): Promise<ContactInfo | null> {
  const { data } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', target.contactId)
    .eq('account_id', target.accountId)
    .maybeSingle()
  return data as ContactInfo | null
}

function contactLineOf(contact: ContactInfo | null): string {
  const phone = contact?.phone ? `+${contact.phone.replace(/^\+/, '')}` : ''
  return [contact?.name?.trim(), phone].filter(Boolean).join(' · ') || 'Cliente'
}

async function contactLine(db: Db, target: AlertTarget): Promise<string> {
  return contactLineOf(await loadContact(db, target))
}

/** +584121234567 → 0412-1234567 (as typed in the platform's form); others unchanged. */
export function localPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (/^58\d{10}$/.test(digits)) return `0${digits.slice(2, 5)}-${digits.slice(5)}`
  return digits ? `+${digits}` : ''
}

function conversationLink(conversationId: string): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!site || !/^https?:\/\//.test(site)) return null
  return `${site}/inbox?c=${encodeURIComponent(conversationId)}`
}

function since(): string {
  return new Date(Date.now() - LOOKBACK_MS).toISOString()
}

/** The customer's most recent message that looks like the filled-in form. */
async function latestRegistroText(db: Db, conversationId: string): Promise<string | null> {
  const { data } = await db
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .eq('content_type', 'text')
    .ilike('content_text', '%registro%')
    .gte('created_at', since())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { content_text: string | null } | null)?.content_text?.trim() || null
}

interface ImageRef {
  mediaUrl: string
  mimeType: string
}

async function latestCustomerImage(db: Db, conversationId: string): Promise<ImageRef | null> {
  const { data } = await db
    .from('messages')
    .select('media_url, media_type')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .in('content_type', ['image', 'document'])
    .gte('created_at', since())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { media_url: string | null; media_type: string | null } | null
  if (!row?.media_url) return null
  return { mediaUrl: row.media_url, mimeType: row.media_type || 'image/jpeg' }
}

/**
 * Bytes of a stored inbound attachment: mirrored copies are public URLs;
 * older/unmirrored ones are the `/api/whatsapp/media/<id>` proxy, which
 * we resolve straight against Meta with the account's token.
 */
async function loadImageBytes(
  db: Db,
  accountId: string,
  image: ImageRef,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string } | null> {
  try {
    if (image.mediaUrl.startsWith(PROXY_MEDIA_PREFIX)) {
      const mediaId = image.mediaUrl.slice(PROXY_MEDIA_PREFIX.length).split(/[?#]/)[0]
      const { accessToken } = await loadAccountMetaCredentials(db, accountId)
      const info = await getMediaUrl({ mediaId, accessToken })
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: info.url,
        accessToken,
      })
      return { bytes: new Uint8Array(buffer), mimeType: contentType || image.mimeType }
    }
    if (!/^https:\/\//.test(image.mediaUrl)) return null
    const res = await fetch(image.mediaUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') || image.mimeType,
    }
  } catch (err) {
    console.warn('[bot alerts] could not load the receipt image:', err)
    return null
  }
}

/**
 * The detected fields in the order of the platform's "Registrar venta y
 * acceso" form (correo, nombre, teléfono, área, canal, productos, plan,
 * referencia), so the owner can copy them top to bottom. Unknown keys
 * go last.
 */
const FORM_ORDER: [string, string][] = [
  ['correo', 'Correo'],
  ['nombre', 'Nombre'],
  ['telefono', 'Teléfono'],
  ['area', 'Área'],
  ['canal', 'Canal'],
  ['producto', 'Productos'],
  ['plan', 'Plan de pago'],
  ['monto', 'Monto'],
  ['ref6', 'Referencia'],
]

export function formatRegistroFields(
  fields: Record<string, string>,
  phone?: string | null,
): string {
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v?.trim()) values[k.trim().toLowerCase()] = v.trim()
  }
  if (!values.telefono && phone) values.telefono = localPhone(phone)
  if (!values.canal) values.canal = 'WhatsApp'
  const known = new Set(FORM_ORDER.map(([k]) => k))
  const lines = FORM_ORDER.filter(([k]) => values[k]).map(([k, label]) => `${label}: ${values[k]}`)
  const extra = Object.entries(values)
    .filter(([k]) => !known.has(k))
    .map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)}: ${v}`)
  return [...lines, ...extra].join('\n')
}

/** Payment receipt + registration to verify. */
export async function alertPaymentToVerify(
  db: Db,
  target: AlertTarget,
  registroFields: Record<string, string> | null,
): Promise<void> {
  if (!isTelegramConfigured()) return
  try {
    const [contact, registro, image] = await Promise.all([
      loadContact(db, target),
      latestRegistroText(db, target.conversationId),
      latestCustomerImage(db, target.conversationId),
    ])
    const who = contactLineOf(contact)
    const link = conversationLink(target.conversationId)
    const extracted = registroFields ? formatRegistroFields(registroFields, contact?.phone) : ''
    const text = [
      '💰 Pago por verificar',
      `👤 ${who}`,
      // Form order first, ready to copy; the customer's own text below for anything extra.
      extracted ? `📋 Para registrar el acceso (en orden):\n${extracted}` : '',
      registro ? `📝 Lo que escribió el cliente:\n${registro}` : '',
      image ? '' : '⚠️ No encontré la captura del pago en el chat.',
      link ? `🔗 ${link}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const sent = await sendTelegramText(text)
    if (!sent.ok) console.warn('[bot alerts] payment alert not sent:', sent.error)

    if (image) {
      const file = await loadImageBytes(db, target.accountId, image)
      if (file) {
        const ext = file.mimeType.split('/')[1]?.split(';')[0] || 'jpg'
        const r = await sendTelegramImage({
          bytes: file.bytes,
          mimeType: file.mimeType,
          fileName: `comprobante.${ext}`,
          caption: `🧾 Comprobante · ${who}`,
        })
        if (!r.ok) console.warn('[bot alerts] receipt image not sent:', r.error)
      }
    }
  } catch (err) {
    console.error('[bot alerts] payment alert failed:', err)
  }
}

/** A conversation the bot handed over to a person. */
export async function alertHandoff(
  db: Db,
  target: AlertTarget,
  reason: string | null,
): Promise<void> {
  if (!isTelegramConfigured()) return
  try {
    const who = await contactLine(db, target)
    const link = conversationLink(target.conversationId)
    const text = [
      '🙋 Un cliente necesita atención de una persona',
      `👤 ${who}`,
      reason ? `Motivo: ${reason}` : '',
      link ? `🔗 ${link}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const sent = await sendTelegramText(text)
    if (!sent.ok) console.warn('[bot alerts] handoff alert not sent:', sent.error)
  } catch (err) {
    console.error('[bot alerts] handoff alert failed:', err)
  }
}
