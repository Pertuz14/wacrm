import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { getMe, InstagramApiError, subscribeToWebhooks } from '@/lib/instagram/api'
import { DEFAULT_INSTAGRAM_CHANNEL_NOTE } from '@/lib/instagram/channel-note'

// Settings → Instagram. Connect (token + app secret), edit the AI note and
// the comment → DM settings, or disconnect. Admins only for changes.

function safeDecrypt(v: string | null | undefined): string | null {
  if (!v) return null
  try {
    return decrypt(v)
  } catch {
    return null
  }
}

/** GET — connection status and settings. The verify token is shown to admins (it goes in Meta's webhook form). */
export async function GET() {
  try {
    const { supabase, role } = await getCurrentAccount()
    const { data } = await supabase.from('instagram_config').select('*').maybeSingle()
    if (!data) return NextResponse.json({ connected: false, defaultAiNote: DEFAULT_INSTAGRAM_CHANNEL_NOTE })
    const isAdmin = role === 'owner' || role === 'admin'
    return NextResponse.json({
      connected: data.status === 'connected',
      username: data.username,
      igAccountId: data.ig_account_id,
      verifyToken: isAdmin ? safeDecrypt(data.verify_token) : null,
      hasAppSecret: Boolean(data.app_secret),
      tokenRefreshedAt: data.token_refreshed_at,
      tokenExpiresAt: data.token_expires_at,
      connectedAt: data.connected_at,
      aiChannelNote: data.ai_channel_note,
      defaultAiNote: DEFAULT_INSTAGRAM_CHANNEL_NOTE,
      commentReplyEnabled: data.comment_reply_enabled,
      commentKeywords: data.comment_keywords ?? [],
      commentReplyText: data.comment_reply_text,
      commentPublicReply: data.comment_public_reply,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST — connect: checks the token with Instagram, saves it encrypted and subscribes the account to webhooks. */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => ({}))) as { accessToken?: string; appSecret?: string }
  const accessToken = body.accessToken?.trim()
  const appSecret = body.appSecret?.trim()
  if (!accessToken) return NextResponse.json({ error: 'Paste the Instagram access token (starts with IGAA).' }, { status: 400 })

  let me
  try {
    me = await getMe(accessToken)
  } catch (err) {
    const msg = err instanceof InstagramApiError ? err.message : 'Could not reach Instagram'
    return NextResponse.json({ error: `Instagram rejected the token: ${msg}` }, { status: 400 })
  }
  const igAccountId = me.user_id ?? me.id

  const { data: existing } = await ctx.supabase.from('instagram_config').select('id, verify_token, app_secret').maybeSingle()
  const verifyToken = safeDecrypt(existing?.verify_token) ?? crypto.randomBytes(18).toString('base64url')
  const now = new Date().toISOString()
  const row = {
    account_id: ctx.accountId,
    user_id: ctx.userId,
    ig_account_id: igAccountId,
    username: me.username ?? null,
    access_token: encrypt(accessToken),
    // Empty secret on a later save keeps the stored one
    app_secret: appSecret ? encrypt(appSecret) : existing?.app_secret ?? null,
    verify_token: encrypt(verifyToken),
    token_refreshed_at: now,
    token_expires_at: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
    status: 'connected',
    connected_at: now,
  }
  const { error } = existing
    ? await ctx.supabase.from('instagram_config').update(row).eq('id', existing.id)
    : await ctx.supabase.from('instagram_config').insert(row)
  if (error) {
    const taken = /idx_instagram_config_ig_account|duplicate key/i.test(error.message)
    return NextResponse.json(
      { error: taken ? 'This Instagram account is already connected to another CRM account.' : error.message },
      { status: taken ? 409 : 500 },
    )
  }

  // Same as the "Webhook subscription" switch in Meta's dashboard
  let subscribed = false
  let subscribeError: string | null = null
  try {
    const r = await subscribeToWebhooks(accessToken)
    subscribed = r.success !== false
  } catch (err) {
    subscribeError = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json({ connected: true, username: me.username ?? null, igAccountId, verifyToken, subscribed, subscribeError })
}

/** PATCH — AI note and comment → DM settings. */
export async function PATCH(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const b = (await request.json().catch(() => ({}))) as {
    aiChannelNote?: string | null
    commentReplyEnabled?: boolean
    commentKeywords?: string[] | string
    commentReplyText?: string | null
    commentPublicReply?: string | null
  }
  const update: Record<string, unknown> = {}
  if ('aiChannelNote' in b) update.ai_channel_note = b.aiChannelNote?.trim() || null
  if ('commentReplyEnabled' in b) update.comment_reply_enabled = b.commentReplyEnabled === true
  if ('commentKeywords' in b) {
    const list = Array.isArray(b.commentKeywords) ? b.commentKeywords : String(b.commentKeywords ?? '').split(',')
    update.comment_keywords = [...new Set(list.map((k) => k.trim()).filter(Boolean))].slice(0, 20)
  }
  if ('commentReplyText' in b) update.comment_reply_text = b.commentReplyText?.trim().slice(0, 1000) || null
  if ('commentPublicReply' in b) update.comment_public_reply = b.commentPublicReply?.trim().slice(0, 300) || null

  if (update.comment_reply_enabled === true) {
    const { data: current } = await ctx.supabase.from('instagram_config').select('comment_keywords, comment_reply_text').maybeSingle()
    const keywords = (update.comment_keywords as string[] | undefined) ?? current?.comment_keywords ?? []
    const text = (update.comment_reply_text as string | null | undefined) ?? current?.comment_reply_text
    if (!keywords.length || !text) {
      return NextResponse.json({ error: 'To turn it on, add at least one keyword and the message to send.' }, { status: 400 })
    }
  }

  const { data, error } = await ctx.supabase.from('instagram_config').update(update).eq('account_id', ctx.accountId).select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: 'Connect Instagram first.' }, { status: 400 })
  return NextResponse.json({ ok: true })
}

/** DELETE — disconnect (conversations and contacts stay). */
export async function DELETE() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { error } = await ctx.supabase.from('instagram_config').delete().eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
