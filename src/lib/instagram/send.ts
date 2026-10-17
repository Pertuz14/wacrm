// ============================================================
// Outbound routing for Instagram conversations.
//
// Every send path (inbox, AI auto-reply, automations) asks
// `conversationChannel` first; Instagram threads go through
// `sendInstagramToContact` instead of WhatsApp Cloud API. Persisting
// the message row stays with each caller, exactly as for WhatsApp.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadInstagramConfig } from './config'
import { INSTAGRAM_TEXT_MAX, sendMedia, sendText, senderAction, type InstagramMediaKind } from './api'

export type Channel = 'whatsapp' | 'instagram'

/** Channel of a conversation; 'whatsapp' when unknown (every pre-050 row). */
export async function conversationChannel(db: SupabaseClient, conversationId: string): Promise<Channel> {
  const { data } = await db.from('conversations').select('channel').eq('id', conversationId).maybeSingle()
  return (data as { channel?: string } | null)?.channel === 'instagram' ? 'instagram' : 'whatsapp'
}

export class InstagramSendError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'InstagramSendError'
    this.code = code
  }
}

/** Splits text longer than Instagram's 1000-char limit at paragraph / sentence boundaries. */
export function splitForInstagram(text: string, max = INSTAGRAM_TEXT_MAX): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const slice = rest.slice(0, max)
    const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'))
    const at = cut > max * 0.5 ? cut + 1 : max
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

interface SendArgs {
  accountId: string
  contactId: string
  kind: 'text' | InstagramMediaKind
  text?: string | null
  mediaUrl?: string | null
  replyToMid?: string | null
}

async function recipientOf(db: SupabaseClient, accountId: string, contactId: string): Promise<string> {
  const { data: contact } = await db
    .from('contacts')
    .select('ig_user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  const igsid = (contact as { ig_user_id?: string | null } | null)?.ig_user_id
  if (!igsid) throw new InstagramSendError('no_instagram_id', 'This contact has no Instagram ID: they have to write to the account first.')
  return igsid
}

/**
 * Send to the contact of an Instagram conversation. Long texts are split
 * into several messages; the id returned is the LAST one sent. Instagram
 * attachments carry no caption, so a media send with text sends the text
 * as a second message and returns its id as `captionMessageId`.
 */
export async function sendInstagramToContact(db: SupabaseClient, args: SendArgs): Promise<{ messageId: string; captionMessageId?: string }> {
  const config = await loadInstagramConfig(db, args.accountId)
  if (!config) throw new InstagramSendError('instagram_not_configured', 'Instagram is not connected. Connect it in Settings → Instagram.')
  const recipientId = await recipientOf(db, args.accountId, args.contactId)

  if (args.kind === 'text') {
    const parts = splitForInstagram(args.text ?? '')
    if (!parts.length) throw new InstagramSendError('bad_request', 'Empty message')
    let last = ''
    for (const [i, part] of parts.entries()) {
      const r = await sendText({ token: config.accessToken, recipientId, text: part, replyToMid: i === 0 ? args.replyToMid ?? undefined : undefined })
      last = r.messageId
    }
    return { messageId: last }
  }
  if (!args.mediaUrl) throw new InstagramSendError('bad_request', 'media_url is required')
  const media = await sendMedia({ token: config.accessToken, recipientId, kind: args.kind, url: args.mediaUrl })
  if (args.text?.trim()) {
    const caption = await sendInstagramToContact(db, { ...args, kind: 'text', mediaUrl: null, replyToMid: null })
    return { messageId: media.messageId, captionMessageId: caption.messageId }
  }
  return { messageId: media.messageId }
}

/** "typing…" in an Instagram chat. Best-effort: never throws. */
export async function instagramTyping(db: SupabaseClient, accountId: string, contactId: string): Promise<void> {
  try {
    const config = await loadInstagramConfig(db, accountId)
    if (!config) return
    const recipientId = await recipientOf(db, accountId, contactId)
    await senderAction({ token: config.accessToken, recipientId, action: 'mark_seen' }).catch(() => {})
    await senderAction({ token: config.accessToken, recipientId, action: 'typing_on' })
  } catch (err) {
    console.warn('[instagram] typing indicator failed (continuing):', err instanceof Error ? err.message : err)
  }
}
