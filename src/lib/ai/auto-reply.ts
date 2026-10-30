import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { aiReplyDebounceMs, buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { loadPromptVariables } from './exchange-rate'
import { applyTemplateVariables } from './pricing'
import { hasAction, parseBotOutput } from './bot-output'
import { alertHandoff, alertPaymentToVerify } from './bot-alerts'
import { syncDealForTurn } from './pipeline-sync'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { instagramTyping } from '@/lib/instagram/send'
import { instagramChannelNote } from '@/lib/instagram/channel-note'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, channel')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    if (inboundMessageId) {
      // Customers often send several messages in a row ("hola", then the
      // question; the receipt, then the registration form). Answer once,
      // with all of them in view: if a newer message arrives during the
      // pause, its own dispatch replies.
      if (!(await isLatestCustomerMessage(db, conversationId, inboundMessageId))) return

      // The pause is long enough for an agent to take the thread over (or
      // for a handoff to land) — re-check before answering.
      const { data: fresh } = await db
        .from('conversations')
        .select('assigned_agent_id, ai_autoreply_disabled')
        .eq('id', conversationId)
        .maybeSingle()
      if (fresh?.assigned_agent_id || fresh?.ai_autoreply_disabled) return

      // Committed to replying: show "typing…" (and mark the message read)
      // while the retrieval + LLM round trips run. Shown AFTER the pause
      // because Meta clears it after 25 s. Strictly best-effort: a failed
      // indicator must never cost us the reply.
      if (conv.channel === 'instagram') await instagramTyping(db, accountId, contactId)
      else await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // The pause above may have let more messages in — read the thread now.
    const transcript = inboundMessageId
      ? await buildConversationContext(db, conversationId)
      : messages
    if (transcript.length === 0) return

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(transcript),
    )

    // Prices in Bs at today's BCV rate etc. are substituted into the
    // prompt here, so the model copies amounts instead of computing them.
    const variables = await loadPromptVariables(db, accountId)
    const basePrompt = applyTemplateVariables(
      buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      }),
      variables,
    )
    // Instagram threads: tell the model which channel it is answering on
    // (editable per account in Settings → Instagram).
    const systemPrompt =
      conv.channel === 'instagram'
        ? `${basePrompt}

${await instagramChannelNote(db, accountId)}`
        : basePrompt

    const { text, handoff: sentinelHandoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages: transcript,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // Split into the customer-facing messages and the control tags the
    // prompt may emit (handoff, payment to verify, registration data).
    const { messages: parts, actions } = parseBotOutput(text)
    const handoffAction = hasAction(actions, 'handoff')
    const handoff = sentinelHandoff || Boolean(handoffAction)
    const target = { accountId, conversationId, contactId }

    // The customer wrote again while this reply was being generated: drop
    // it — the newer message's own dispatch answers with everything in
    // view, so the customer doesn't get two answers in a row.
    if (
      inboundMessageId &&
      (await hasNewerDispatchingInbound(db, conversationId, inboundMessageId))
    ) {
      return
    }

    if (parts.length > 0) {
      // Atomically claim a reply slot: the cap check + increment happen in
      // one UPDATE, so concurrent inbounds can never overshoot the cap. If
      // another inbound just took the last slot, `claimed` is false and we
      // skip the send. (We consume a slot slightly before the send lands —
      // fail-safe: under-reply rather than over-reply.) One slot covers
      // every message of this turn.
      const { data: claimed, error: claimErr } = await db.rpc(
        'claim_ai_reply_slot',
        {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        },
      )
      if (claimErr) {
        // A real error here (vs. losing the cap race) is almost always a
        // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
        // service role, or the migration not applied. Log it loudly: a
        // silent return makes "auto-reply never fires" undiagnosable.
        console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
        return
      }
      if (claimed !== true) return // lost the per-conversation cap race

      // Sequential, with a short gap, so the bubbles arrive in order.
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) await sleep(MESSAGE_GAP_MS)
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: parts[i],
          aiGenerated: true,
        })
      }
    }

    if (hasAction(actions, 'verify_payment')) {
      await alertPaymentToVerify(db, target, hasAction(actions, 'registro')?.fields ?? null)
    }

    // Create / advance the contact's deal from this turn's stage labels
    // (no-op unless pipeline sync is configured; never throws).
    await syncDealForTurn(db, { ...target, configOwnerUserId, actions })

    if (handoff || parts.length === 0) {
      // The model can't (or shouldn't) keep answering — stop auto-replying
      // on this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent. Any goodbye message the model wrote
      // ("a person will help you shortly") was already sent above.
      const summary = buildHandoffSummary({
        messages: transcript,
        replyCount: conv.ai_reply_count ?? 0,
      })
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true, ai_handoff_summary: summary })
        .eq('id', conversationId)
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId) {
        await db
          .from('conversations')
          .update({ assigned_agent_id: config.handoffAgentId })
          .eq('id', conversationId)
          .is('assigned_agent_id', null)
      }
      await alertHandoff(db, target, handoffAction?.reason ?? null)
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/** Pause between the messages of one turn so WhatsApp keeps their order. */
const MESSAGE_GAP_MS = 700

/** Inbound content types that trigger their own auto-reply dispatch
 *  (see the webhook). A newer one of these supersedes an older dispatch;
 *  anything else (a sticker, a reaction) never does, so it can't leave
 *  the customer without an answer. */
const DISPATCHING_CONTENT_TYPES = ['text', 'image', 'audio', 'video', 'document']

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * True when the customer sent a newer message that triggers its own
 * auto-reply after `inboundMessageId`. Fails safe (false → reply anyway)
 * on any lookup problem: a duplicate answer is better than none.
 */
async function hasNewerDispatchingInbound(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  inboundMessageId: string,
): Promise<boolean> {
  try {
    const { data: own } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('message_id', inboundMessageId)
      .limit(1)
    const createdAt = (own as { created_at: string }[] | null)?.[0]?.created_at
    if (!createdAt) return false
    const { data: newer } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .in('content_type', DISPATCHING_CONTENT_TYPES)
      .gt('created_at', createdAt)
      .limit(1)
    return Boolean(newer && newer.length > 0)
  } catch (err) {
    console.warn('[ai auto-reply] newer-inbound check failed (replying anyway):', err)
    return false
  }
}

/**
 * Wait the debounce window, then report whether this inbound is still the
 * customer's latest message. False means a newer message arrived; its own
 * dispatch will answer with the whole burst in view. Fails open (true) on
 * any lookup problem — a missed debounce is better than no reply.
 */
async function isLatestCustomerMessage(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const debounceMs = aiReplyDebounceMs()
  if (debounceMs <= 0) return true
  await sleep(debounceMs)
  return !(await hasNewerDispatchingInbound(db, conversationId, inboundMessageId))
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
