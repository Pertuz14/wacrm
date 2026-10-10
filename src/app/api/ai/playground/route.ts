import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { aiContextMessageLimit, buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadPromptVariables } from '@/lib/ai/exchange-rate'
import { applyTemplateVariables } from '@/lib/ai/pricing'
import { hasAction, parseBotOutput } from '@/lib/ai/bot-output'
import { AiError, type ChatMessage } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')


/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: t('ai.messagesRequired') }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      // Bounded exactly like the live bot's context window.
      .slice(-aiContextMessageLimit())

    if (messages.length === 0) {
      return NextResponse.json(
        { error: t('ai.sendMessageToTest') },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError(t('ai.storedKeyUndecryptable'), {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: t('ai.noAgentConfigured'),
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )
    // Same price substitution as the live bot. Service role: an agent may
    // test, but only the service role may store a refreshed rate.
    let variables: Record<string, string> = {}
    try {
      variables = await loadPromptVariables(supabaseAdmin(), accountId)
    } catch (err) {
      console.error('[ai/playground] prompt variables skipped:', err)
    }
    const systemPrompt = applyTemplateVariables(
      buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      }),
      variables,
    )

    const { text, handoff } = await generateReply({ config, systemPrompt, messages })
    // Show exactly what the customer would get: the separate messages,
    // plus the actions the live bot would take (nothing is sent here).
    const { messages: replies, actions } = parseBotOutput(text)
    return NextResponse.json({
      reply: replies.join('\n\n'),
      replies,
      actions,
      handoff: handoff || Boolean(hasAction(actions, 'handoff')),
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
