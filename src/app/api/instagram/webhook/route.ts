import crypto from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { verifySignatureWithSecrets } from '@/lib/whatsapp/webhook-signature'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { notifyInboundMessage } from '@/lib/notifications/web-push'
import { pickContactDisplayName } from '@/lib/notifications/browser-notify'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  instagramVerifyTokens,
  instagramWebhookSecrets,
  loadInstagramConfigByIgAccount,
  type InstagramConfig,
} from '@/lib/instagram/config'
import { getUserProfile, replyToComment, sendPrivateReply } from '@/lib/instagram/api'
import { matchCommentKeyword, parseInstagramWebhook, type IgEvent, type IgWebhookBody } from '@/lib/instagram/webhook-parse'

// Instagram Direct → inbox. Mirrors /api/whatsapp/webhook: verify the
// signature, ack Meta at once, and process inside `after()` so the work
// is not frozen once the response is sent.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
function db(): SupabaseClient {
  if (!_admin) _admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return _admin
}

// GET — Meta's verification handshake ("Verificar y guardar" in the app dashboard)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const verifyToken = searchParams.get('hub.verify_token')
  if (mode !== 'subscribe' || !challenge || !verifyToken) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }
  const tokens = await instagramVerifyTokens(db())
  if (!tokens.includes(verifyToken)) {
    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// POST — DMs, echoes, reactions, postbacks and comments
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  if (!verifySignatureWithSecrets(rawBody, signature, await instagramWebhookSecrets(db()))) {
    console.warn('[instagram webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  let body: IgWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  after(async () => {
    try {
      await processEvents(parseInstagramWebhook(body))
    } catch (err) {
      console.error('[instagram webhook] processing failed:', err)
    }
  })
  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processEvents(events: IgEvent[]) {
  const configs = new Map<string, InstagramConfig | null>()
  for (const ev of events) {
    if (!configs.has(ev.igAccountId)) configs.set(ev.igAccountId, await loadInstagramConfigByIgAccount(db(), ev.igAccountId))
    const config = configs.get(ev.igAccountId)
    if (!config) {
      console.warn('[instagram webhook] no connected config for Instagram account', ev.igAccountId)
      continue
    }
    try {
      if (ev.kind === 'message') await handleMessage(config, ev)
      else if (ev.kind === 'postback') {
        await handleMessage(config, {
          kind: 'message', igAccountId: ev.igAccountId, customerId: ev.customerId, isEcho: false, mid: ev.mid,
          timestamp: ev.timestamp, text: ev.title || ev.payload, contentType: 'text', mediaUrl: null,
          replyToMid: null, storyReplyUrl: null, quickReplyPayload: ev.payload, isDeleted: false,
        })
      } else if (ev.kind === 'reaction') await handleReaction(config, ev)
      else if (ev.kind === 'comment') await handleComment(config, ev)
    } catch (err) {
      console.error(`[instagram webhook] ${ev.kind} failed:`, err)
    }
  }
}

// ── Contacts and conversations ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

async function findOrCreateContact(config: InstagramConfig, igsid: string, usernameHint: string | null): Promise<{ contact: Row; created: boolean } | null> {
  const { data: existing } = await db()
    .from('contacts')
    .select('*')
    .eq('account_id', config.accountId)
    .eq('ig_user_id', igsid)
    .maybeSingle()
  if (existing) {
    // A username we did not have yet (e.g. first seen through a comment, now writing by DM)
    if (usernameHint && !existing.ig_username) {
      await db().from('contacts').update({ ig_username: usernameHint, updated_at: new Date().toISOString() }).eq('id', existing.id)
      existing.ig_username = usernameHint
    }
    return { contact: existing, created: false }
  }

  // Name and username from the User Profile API (best-effort: a failure leaves the IGSID as the name)
  let name: string | null = null
  let username = usernameHint
  try {
    const profile = await getUserProfile({ token: config.accessToken, igsid })
    name = profile.name?.trim() || null
    username = profile.username?.trim() || username
  } catch (err) {
    console.warn('[instagram webhook] profile lookup failed:', err instanceof Error ? err.message : err)
  }

  const { data: created, error } = await db()
    .from('contacts')
    .insert({
      account_id: config.accountId,
      user_id: config.userId,
      phone: '',
      name: name || (username ? `@${username}` : `Instagram ${igsid.slice(-6)}`),
      ig_user_id: igsid,
      ig_username: username,
    })
    .select()
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await db().from('contacts').select('*').eq('account_id', config.accountId).eq('ig_user_id', igsid).maybeSingle()
      if (raced) return { contact: raced, created: false }
    }
    console.error('[instagram webhook] contact insert failed:', error.message)
    return null
  }
  return { contact: created, created: true }
}

async function findOrCreateConversation(config: InstagramConfig, contactId: string): Promise<{ conversation: Row; created: boolean } | null> {
  const find = () =>
    db().from('conversations').select('*').eq('account_id', config.accountId).eq('contact_id', contactId)
      .order('created_at', { ascending: true }).limit(1)
  const { data: rows } = await find()
  if (rows?.length) return { conversation: rows[0], created: false }
  const { data: created, error } = await db()
    .from('conversations')
    .insert({ account_id: config.accountId, user_id: config.userId, contact_id: contactId, channel: 'instagram' })
    .select()
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await find()
      if (raced?.length) return { conversation: raced[0], created: false }
    }
    console.error('[instagram webhook] conversation insert failed:', error.message)
    return null
  }
  return { conversation: created, created: true }
}

// ── Media: Instagram CDN links expire, so attachments are copied to `chat-media` ──

const MIME_GUESS: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mp4', document: 'application/pdf' }

async function mirrorAttachment(accountId: string, mid: string, url: string, contentType: string, timestamp: number): Promise<string> {
  const mirrored = await mirrorInboundMedia({
    storage: db().storage,
    accountId,
    // Short, deterministic id (Instagram mids are ~100 characters)
    mediaId: crypto.createHash('sha1').update(mid).digest('hex').slice(0, 16),
    downloadUrl: url,
    accessToken: '',
    mimeType: MIME_GUESS[contentType] ?? null,
    messageTimestamp: Math.floor(timestamp / 1000),
    // Public CDN URL: no Authorization header
    download: async ({ downloadUrl }) => {
      const res = await fetch(downloadUrl)
      if (!res.ok) throw new Error(`Instagram media download failed: ${res.status}`)
      return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'application/octet-stream' }
    },
  })
  return mirrored ?? url
}

// ── Messages ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function lookupInternalId(mid: string, conversationId: string): Promise<string | null> {
  const { data } = await db().from('messages').select('id').eq('message_id', mid).eq('conversation_id', conversationId).maybeSingle()
  return data?.id ?? null
}

async function handleMessage(config: InstagramConfig, ev: Extract<IgEvent, { kind: 'message' }>) {
  const contactOutcome = await findOrCreateContact(config, ev.customerId, null)
  if (!contactOutcome) return
  const contact = contactOutcome.contact
  const convResult = await findOrCreateConversation(config, contact.id)
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(db(), config.accountId, 'conversation.created', { conversation_id: conversation.id, contact_id: contact.id })
  }

  const mediaUrl = ev.mediaUrl ? await mirrorAttachment(config.accountId, ev.mid, ev.mediaUrl, ev.contentType, ev.timestamp) : null
  const text = ev.storyReplyUrl ? `[Respondió a su historia] ${ev.text ?? ''}`.trim() : ev.text
  const replyTo = ev.replyToMid ? await lookupInternalId(ev.replyToMid, conversation.id) : null

  if (ev.isEcho) {
    // Echo of a message the business sent. The CRM's own sends are already
    // stored (with this mid) right after the API answers; give that insert a
    // head start, then store only what was sent from the Instagram app itself.
    await sleep(5000)
    if (await lookupInternalId(ev.mid, conversation.id)) return
    const { error } = await db()
      .from('messages')
      .upsert(
        {
          conversation_id: conversation.id, sender_type: 'agent', content_type: ev.contentType, content_text: text,
          media_url: mediaUrl, message_id: ev.mid, status: 'sent', created_at: new Date(ev.timestamp).toISOString(),
          reply_to_message_id: replyTo,
        },
        { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
      )
    if (error) console.error('[instagram webhook] echo insert failed:', error.message)
    await db().from('conversations').update({ last_message_text: text || `[${ev.contentType}]`, last_message_at: new Date().toISOString() }).eq('id', conversation.id)
    return
  }

  const { count: prior } = await db()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInbound = (prior ?? 0) === 0

  // Idempotent insert: Meta retries deliveries with the same mid.
  const { data: inserted, error: msgError } = await db()
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id, sender_type: 'customer', content_type: ev.contentType, content_text: text,
        media_url: mediaUrl, message_id: ev.mid, status: 'delivered', created_at: new Date(ev.timestamp).toISOString(),
        reply_to_message_id: replyTo,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (msgError) {
    console.error('[instagram webhook] message insert failed:', msgError.message)
    return
  }
  if (!inserted?.length) return // replay

  await db().rpc('bump_conversation_on_inbound', { p_conversation_id: conversation.id, p_last_message_text: text || `[${ev.contentType}]` })
  await reopenClosedConversation(db(), conversation)
  await notifyInboundMessage(db(), {
    accountId: config.accountId,
    conversationId: conversation.id,
    messageId: ev.mid,
    contactName: pickContactDisplayName(contact) ?? (contact.ig_username ? `@${contact.ig_username}` : null),
    contentType: ev.contentType,
    contentText: text,
  })

  // Automations (text steps reach Instagram; WhatsApp-only steps such as
  // templates fail for this contact and are logged). Flows are WhatsApp-only
  // (interactive menus) and are not dispatched here.
  const inboundText = text ?? ''
  const triggers: ('new_contact_created' | 'first_inbound_message' | 'new_message_received' | 'keyword_match')[] = ['new_message_received', 'keyword_match']
  if (contactOutcome.created) triggers.unshift('new_contact_created')
  if (isFirstInbound) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId: config.accountId,
      triggerType,
      contactId: contact.id,
      context: { message_text: inboundText, conversation_id: conversation.id },
    }).catch((err) => console.error('[instagram webhook] automations failed:', err))
  }

  if (inboundText.trim() || ['image', 'audio', 'video', 'document'].includes(ev.contentType)) {
    await dispatchInboundToAiReply({
      accountId: config.accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: config.userId,
      inboundMessageId: ev.mid,
    })
  }

  await dispatchWebhookEvent(db(), config.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: ev.mid,
    content_type: ev.contentType,
    text,
    channel: 'instagram',
  })
}

async function handleReaction(config: InstagramConfig, ev: Extract<IgEvent, { kind: 'reaction' }>) {
  const { data: contact } = await db().from('contacts').select('id').eq('account_id', config.accountId).eq('ig_user_id', ev.customerId).maybeSingle()
  if (!contact) return
  const { data: target } = await db()
    .from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('message_id', ev.mid)
    .eq('conversations.account_id', config.accountId)
    .limit(1)
    .maybeSingle()
  if (!target) return
  if (ev.removed || !ev.emoji) {
    await db().from('message_reactions').delete().eq('message_id', target.id).eq('actor_type', 'customer').eq('actor_id', contact.id)
    return
  }
  await db().from('message_reactions').upsert(
    { message_id: target.id, conversation_id: target.conversation_id, actor_type: 'customer', actor_id: contact.id, emoji: ev.emoji },
    { onConflict: 'message_id,actor_type,actor_id' },
  )
}

// ── Comment → DM ──

async function handleComment(config: InstagramConfig, ev: Extract<IgEvent, { kind: 'comment' }>) {
  if (!config.commentReplyEnabled || !config.commentReplyText?.trim()) return
  const keyword = matchCommentKeyword(ev.text, config.commentKeywords)
  if (!keyword) return

  // Claim the comment first: a replayed webhook must never DM twice.
  const { error: claimError } = await db()
    .from('instagram_comment_replies')
    .insert({ account_id: config.accountId, comment_id: ev.commentId, media_id: ev.mediaId, from_id: ev.fromId, keyword })
  if (claimError) {
    if (!isUniqueViolation(claimError)) console.error('[instagram webhook] comment claim failed:', claimError.message)
    return
  }

  const dmText = config.commentReplyText.trim()
  const sent = await sendPrivateReply({ token: config.accessToken, commentId: ev.commentId, text: dmText })
  if (config.commentPublicReply?.trim()) {
    await replyToComment({ token: config.accessToken, commentId: ev.commentId, text: config.commentPublicReply.trim() })
      .catch((err) => console.warn('[instagram webhook] public comment reply failed:', err instanceof Error ? err.message : err))
  }

  // Keep the private reply in the inbox so the thread starts with it.
  const contactOutcome = await findOrCreateContact(config, ev.fromId, ev.fromUsername)
  if (!contactOutcome) return
  const convResult = await findOrCreateConversation(config, contactOutcome.contact.id)
  if (!convResult) return
  await db().from('messages').upsert(
    {
      conversation_id: convResult.conversation.id, sender_type: 'bot', content_type: 'text',
      content_text: dmText, message_id: sent.messageId, status: 'sent',
    },
    { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
  )
  await db().from('conversations').update({
    last_message_text: `[Comentó «${ev.text.slice(0, 60)}»] ${dmText}`.slice(0, 200),
    last_message_at: new Date().toISOString(),
  }).eq('id', convResult.conversation.id)
}
