// ============================================================
// Connected Instagram account of a CRM account (instagram_config).
//
// The token is stored encrypted and refreshed lazily: whenever a
// send/webhook loads the config and the token is more than a week
// old, it is swapped for a fresh 60-day token (best-effort — a failed
// refresh keeps the current one, which is still valid for weeks).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { refreshToken } from './api'

export interface InstagramConfig {
  id: string
  accountId: string
  userId: string
  igAccountId: string
  username: string | null
  accessToken: string
  appSecret: string | null
  aiChannelNote: string | null
  commentReplyEnabled: boolean
  commentKeywords: string[]
  commentReplyText: string | null
  commentPublicReply: string | null
}

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return decrypt(value)
  } catch {
    return null
  }
}

function fromRow(row: Row): InstagramConfig | null {
  const token = safeDecrypt(row.access_token)
  if (!token) return null
  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    igAccountId: row.ig_account_id,
    username: row.username ?? null,
    accessToken: token,
    appSecret: safeDecrypt(row.app_secret),
    aiChannelNote: row.ai_channel_note ?? null,
    commentReplyEnabled: row.comment_reply_enabled === true,
    commentKeywords: Array.isArray(row.comment_keywords) ? row.comment_keywords : [],
    commentReplyText: row.comment_reply_text ?? null,
    commentPublicReply: row.comment_public_reply ?? null,
  }
}

/** Refresh the stored token when it is older than a week. Never throws. */
async function maybeRefresh(db: SupabaseClient, row: Row, config: InstagramConfig): Promise<InstagramConfig> {
  const last = row.token_refreshed_at ? Date.parse(row.token_refreshed_at) : 0
  if (Date.now() - last < REFRESH_AFTER_MS) return config
  try {
    const { accessToken, expiresIn } = await refreshToken(config.accessToken)
    const now = new Date()
    await db
      .from('instagram_config')
      .update({
        access_token: encrypt(accessToken),
        token_refreshed_at: now.toISOString(),
        token_expires_at: expiresIn ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
      })
      .eq('id', config.id)
    return { ...config, accessToken }
  } catch (err) {
    console.warn('[instagram] token refresh failed (keeping the current token):', err instanceof Error ? err.message : err)
    return config
  }
}

/** Config of a CRM account, or null when Instagram is not connected. */
export async function loadInstagramConfig(db: SupabaseClient, accountId: string): Promise<InstagramConfig | null> {
  const { data, error } = await db
    .from('instagram_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .maybeSingle()
  if (error || !data) return null
  const config = fromRow(data)
  return config ? maybeRefresh(db, data, config) : null
}

/** Config that owns an Instagram professional account (webhook `entry.id`). */
export async function loadInstagramConfigByIgAccount(db: SupabaseClient, igAccountId: string): Promise<InstagramConfig | null> {
  const { data, error } = await db
    .from('instagram_config')
    .select('*')
    .eq('ig_account_id', igAccountId)
    .eq('status', 'connected')
    .maybeSingle()
  if (error || !data) return null
  const config = fromRow(data)
  return config ? maybeRefresh(db, data, config) : null
}

/** Every stored app secret plus META_APP_SECRET — candidates for the webhook signature. */
export async function instagramWebhookSecrets(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('instagram_config').select('app_secret')
  const stored = ((data ?? []) as Row[]).map((r) => safeDecrypt(r.app_secret)).filter((s): s is string => Boolean(s))
  const env = (process.env.META_APP_SECRET ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return [...new Set([...stored, ...env])]
}

/** Every stored verify token (decrypted), for the webhook GET handshake. */
export async function instagramVerifyTokens(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('instagram_config').select('verify_token')
  return ((data ?? []) as Row[]).map((r) => safeDecrypt(r.verify_token)).filter((s): s is string => Boolean(s))
}
