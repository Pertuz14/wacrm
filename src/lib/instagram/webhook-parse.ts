// ============================================================
// Instagram webhook payload → flat events (pure, unit-tested).
//
// Instagram Login webhooks arrive as
//   { object: 'instagram', entry: [{ id: <IG account id>, messaging: [...], changes: [...] }] }
// `messaging` carries DMs (and their echoes, reactions, postbacks and
// read receipts); `changes` carries comments.
// ============================================================

import type { IgReferral } from '@/lib/leads/source'
import { stickerLabel } from '@/lib/rumbo/instagram-sticker'

export interface IgAttachment {
  type: string
  payload?: { url?: string; title?: string; reel_video_id?: string; ig_post_media_id?: string }
}

export interface IgMessagingItem {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    attachments?: IgAttachment[]
    is_echo?: boolean
    is_deleted?: boolean
    is_unsupported?: boolean
    reply_to?: { mid?: string; story?: { url?: string; id?: string } }
    quick_reply?: { payload?: string }
    /** Click-to-Instagram-Direct ad (some API versions put it here). */
    referral?: IgReferral
  }
  /** Click-to-Instagram-Direct ad that opened the thread. */
  referral?: IgReferral
  reaction?: { mid?: string; action?: 'react' | 'unreact'; reaction?: string; emoji?: string }
  postback?: { mid?: string; title?: string; payload?: string }
  read?: { mid?: string }
}

export interface IgCommentValue {
  id?: string
  text?: string
  parent_id?: string
  from?: { id?: string; username?: string; self_ig_scoped_id?: string }
  media?: { id?: string; media_product_type?: string }
}

export interface IgWebhookBody {
  object?: string
  entry?: Array<{
    id?: string
    time?: number
    messaging?: IgMessagingItem[]
    changes?: Array<{ field?: string; value?: IgCommentValue }>
  }>
}

export type IgEvent =
  | {
      kind: 'message'
      igAccountId: string
      /** The customer (for an echo, the recipient). */
      customerId: string
      /** True when the business sent it (from the Instagram app or through the API). */
      isEcho: boolean
      mid: string
      timestamp: number
      text: string | null
      contentType: 'text' | 'image' | 'video' | 'audio' | 'document'
      mediaUrl: string | null
      replyToMid: string | null
      /** A reply to one of our stories. */
      storyReplyUrl: string | null
      quickReplyPayload: string | null
      isDeleted: boolean
      /** Ad that opened the thread, when Meta sends one. */
      referral: IgReferral | null
      /** Id of a post or reel shared in the DM (an ad's post arrives this way, often without `referral`). */
      sharedAssetId: string | null
    }
  | { kind: 'reaction'; igAccountId: string; customerId: string; mid: string; emoji: string | null; removed: boolean }
  | { kind: 'postback'; igAccountId: string; customerId: string; mid: string; timestamp: number; title: string; payload: string }
  | {
      kind: 'comment'
      igAccountId: string
      commentId: string
      text: string
      fromId: string
      fromUsername: string | null
      mediaId: string | null
      isReply: boolean
    }

/** Inbox content type for an Instagram attachment. */
export function attachmentContentType(type: string | undefined): 'text' | 'image' | 'video' | 'audio' | 'document' {
  switch (type) {
    case 'image':
    case 'animated_image':
    case 'sticker':
      return 'image'
    case 'video':
    case 'ig_reel':
    case 'reel':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
      return 'document'
    default:
      return 'text' // share, story_mention, fallback, unknown → described in text
  }
}

/**
 * A post or reel attached from Instagram's own CDN (`lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=…`). This is how
 * a DM written from an ad shows the ad's post, and how a shared post arrives in newer API versions (type `ig_post` or
 * a type this parser does not know yet). The link is temporary and useless as text: it is never shown.
 */
const isIgAssetUrl = (url: string | undefined) => /^https:\/\/lookaside\.fbsbx\.com\/ig_messaging_cdn\//.test(url ?? '')

/** Id of the shared post or reel, or null. */
export function sharedAssetId(a: IgAttachment | undefined): string | null {
  if (!a) return null
  let fromUrl: string | null = null
  if (isIgAssetUrl(a.payload?.url)) {
    try {
      fromUrl = new URL(a.payload!.url!).searchParams.get('asset_id')
    } catch {
      fromUrl = null
    }
  }
  const id = a.payload?.ig_post_media_id ?? fromUrl
  return id && /^\d{5,30}$/.test(id) ? id : null
}

/** Readable text for attachments that are not plain media. */
function attachmentLabel(a: IgAttachment): string | null {
  switch (a.type) {
    case 'share':
    case 'ig_post':
      return a.payload?.title ? `[Compartió una publicación de Instagram: ${a.payload.title}]` : '[Compartió una publicación de Instagram]'
    case 'story_mention':
      return '[Le mencionó en su historia]'
    case 'ig_reel':
    case 'reel':
      return a.payload?.title ? `[Compartió un reel: ${a.payload.title}]` : '[Compartió un reel]'
    case 'fallback':
      return '[Enlace compartido]'
    default:
      return isIgAssetUrl(a.payload?.url)
        ? a.payload?.title ? `[Compartió una publicación de Instagram: ${a.payload.title}]` : '[Compartió una publicación de Instagram]'
        : null
  }
}

export function parseInstagramWebhook(body: IgWebhookBody): IgEvent[] {
  const events: IgEvent[] = []
  for (const entry of body.entry ?? []) {
    const igAccountId = String(entry.id ?? '')
    if (!igAccountId) continue

    for (const m of entry.messaging ?? []) {
      const senderId = m.sender?.id ?? ''
      const recipientId = m.recipient?.id ?? ''
      if (m.message?.mid) {
        const msg = m.message
        const isEcho = msg.is_echo === true || senderId === igAccountId
        const customerId = isEcho ? recipientId : senderId
        if (!customerId) continue
        const first = msg.attachments?.[0]
        const contentType = first ? attachmentContentType(first.type) : 'text'
        // Rumbo (RUMBO.md, cambio 14): stickers and GIFs say so, so the bot never takes one for a receipt
        const label = first ? stickerLabel(first) ?? attachmentLabel(first) : null
        const mediaUrl = first && contentType !== 'text' ? first.payload?.url ?? null : null
        const text = msg.is_deleted
          ? '[Mensaje eliminado]'
          : msg.is_unsupported
            ? '[Mensaje no compatible: ábralo en Instagram]'
            : [msg.text, label, contentType === 'text' && first?.payload?.url && !isIgAssetUrl(first.payload.url) ? first.payload.url : null]
                .filter(Boolean)
                .join(' ') || null
        events.push({
          kind: 'message',
          igAccountId,
          customerId,
          isEcho,
          mid: msg.mid!,
          timestamp: m.timestamp ?? Date.now(),
          text,
          contentType: msg.is_deleted || msg.is_unsupported ? 'text' : contentType,
          mediaUrl,
          replyToMid: msg.reply_to?.mid ?? null,
          storyReplyUrl: msg.reply_to?.story?.url ?? null,
          quickReplyPayload: msg.quick_reply?.payload ?? null,
          isDeleted: msg.is_deleted === true,
          referral: msg.referral ?? m.referral ?? null,
          sharedAssetId: sharedAssetId(first),
        })
      } else if (m.reaction?.mid && senderId && senderId !== igAccountId) {
        events.push({
          kind: 'reaction',
          igAccountId,
          customerId: senderId,
          mid: m.reaction.mid,
          emoji: m.reaction.emoji ?? (m.reaction.reaction === 'love' ? '❤️' : m.reaction.reaction ?? null),
          removed: m.reaction.action === 'unreact',
        })
      } else if (m.postback && senderId && senderId !== igAccountId) {
        events.push({
          kind: 'postback',
          igAccountId,
          customerId: senderId,
          mid: m.postback.mid ?? `postback-${m.timestamp ?? Date.now()}`,
          timestamp: m.timestamp ?? Date.now(),
          title: m.postback.title ?? '',
          payload: m.postback.payload ?? '',
        })
      }
      // `read` receipts are ignored: the inbox has no per-message read state for Instagram yet.
    }

    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments' || !change.value?.id) continue
      const v = change.value
      const fromId = v.from?.id ?? ''
      // Our own replies under a post also arrive as comments: skip them.
      if (!fromId || fromId === igAccountId) continue
      events.push({
        kind: 'comment',
        igAccountId,
        commentId: v.id!,
        text: v.text ?? '',
        fromId,
        fromUsername: v.from?.username ?? null,
        mediaId: v.media?.id ?? null,
        isReply: Boolean(v.parent_id),
      })
    }
  }
  return events
}

/** Lower-case, without accents or punctuation — «GUÍA!» and «guia» match. */
export function normalizeForKeyword(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First keyword the comment contains as a whole word (or phrase), or null. */
export function matchCommentKeyword(text: string, keywords: string[]): string | null {
  const haystack = ` ${normalizeForKeyword(text)} `
  for (const k of keywords) {
    const needle = normalizeForKeyword(k)
    if (needle && haystack.includes(` ${needle} `)) return k
  }
  return null
}

/** Instagram only lets a business reply within 24 hours of the customer's last message. */
export const INSTAGRAM_WINDOW_MS = 24 * 60 * 60 * 1000

export function isInsideWindow(lastCustomerMessageAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastCustomerMessageAt) return false
  const t = Date.parse(lastCustomerMessageAt)
  return Number.isFinite(t) && now - t < INSTAGRAM_WINDOW_MS
}
