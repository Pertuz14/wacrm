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

async function contactLine(db: Db, target: AlertTarget): Promise<string> {
  const { data } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', target.contactId)
    .eq('account_id', target.accountId)
    .maybeSingle()
  const contact = data as { name: string | null; phone: string | null } | null
  const phone = contact?.phone ? `+${contact.phone.replace(/^\+/, '')}` : ''
  return [contact?.name?.trim(), phone].filter(Boolean).join(' · ') || 'Cliente'
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

function formatRegistroFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `• ${k}: ${v}`)
    .join('\n')
}

/** Payment receipt + registration to verify. */
export async function alertPaymentToVerify(
  db: Db,
  target: AlertTarget,
  registroFields: Record<string, string> | null,
): Promise<void> {
  if (!isTelegramConfigured()) return
  try {
    const [who, registro, image] = await Promise.all([
      contactLine(db, target),
      latestRegistroText(db, target.conversationId),
      latestCustomerImage(db, target.conversationId),
    ])
    const link = conversationLink(target.conversationId)
    const extracted = registroFields ? formatRegistroFields(registroFields) : ''
    const text = [
      '💰 Pago por verificar',
      `👤 ${who}`,
      registro ? `📝 Registro enviado por el cliente:\n${registro}` : '',
      extracted ? `🔎 Datos detectados:\n${extracted}` : '',
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
