import webpush from 'web-push'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContentType } from '@/types'
import { getT } from '@/lib/i18n/translate'
import {
  DEFAULT_NOTIFICATION_LABELS,
  buildNotificationContent,
  conversationHref,
  type NotificationLabels,
} from './browser-notify'

/**
 * Web Push: notifications that reach the team's PCs, phones and tablets
 * even when the app is closed. Needs a VAPID key pair in the environment
 * (generate once with `npx web-push generate-vapid-keys`):
 *
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@…)
 *
 * Without them every function here is a silent no-op, and the in-tab
 * desktop notifications keep working as before.
 */

export interface PushPayload {
  title: string
  body: string
  /** Opened when the notification is tapped. */
  url: string
  /** Same tag = replaces the previous alert (one per conversation). */
  tag: string
  conversationId?: string
}

let configured: boolean | null = null

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null
}

function ensureConfigured(): boolean {
  if (configured !== null) return configured
  const publicKey = vapidPublicKey()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || !privateKey) return (configured = false)
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@example.com'
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    configured = true
  } catch (err) {
    console.error('[web-push] invalid VAPID keys — push disabled:', err)
    configured = false
  }
  return configured
}

export function isWebPushConfigured(): boolean {
  return ensureConfigured()
}

interface SubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Push one payload to every registered device of the account. Never
 * throws; subscriptions the push service reports as gone (404/410) are
 * deleted. Returns how many devices accepted it.
 */
export async function sendPushToAccount(
  db: SupabaseClient,
  accountId: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureConfigured()) return 0
  try {
    const { data, error } = await db
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('account_id', accountId)
    if (error || !data?.length) return 0

    const body = JSON.stringify(payload)
    const gone: string[] = []
    const used: string[] = []
    await Promise.all(
      (data as SubscriptionRow[]).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 60 * 60, urgency: 'high', topic: topicFor(payload.tag) },
          )
          used.push(sub.id)
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) gone.push(sub.id)
          else console.warn('[web-push] send failed:', status ?? err)
        }
      }),
    )
    if (gone.length) await db.from('push_subscriptions').delete().in('id', gone)
    if (used.length) {
      await db
        .from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .in('id', used)
    }
    return used.length
  } catch (err) {
    console.error('[web-push] dispatch failed:', err)
    return 0
  }
}

/** Topic must be ≤32 URL-safe chars; it collapses queued pushes per thread. */
function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'wacrm'
}

let labelsCache: NotificationLabels | null = null
function labels(): NotificationLabels {
  if (labelsCache) return labelsCache
  try {
    const t = getT('Settings.browserNotifications.labels')
    labelsCache = {
      fallbackTitle: t('fallbackTitle'),
      image: t('image'),
      audio: t('audio'),
      video: t('video'),
      document: t('document'),
      location: t('location'),
      template: t('template'),
    }
  } catch {
    labelsCache = DEFAULT_NOTIFICATION_LABELS
  }
  return labelsCache
}

/** Push for a freshly-arrived customer message (called by the webhook). */
export async function notifyInboundMessage(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    messageId: string
    contactName: string | null
    /** messages.content_type of the stored row. */
    contentType: string
    contentText: string | null
  },
): Promise<void> {
  if (!ensureConfigured()) return
  const { title, body } = buildNotificationContent(
    {
      id: args.messageId,
      conversation_id: args.conversationId,
      sender_type: 'customer',
      content_type: args.contentType as ContentType,
      content_text: args.contentText,
    },
    args.contactName,
    labels(),
  )
  await sendPushToAccount(db, args.accountId, {
    title,
    body,
    url: conversationHref(args.conversationId),
    tag: args.conversationId,
    conversationId: args.conversationId,
  })
}
