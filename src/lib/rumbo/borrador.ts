// ============================================================
// Rumbo a la U — local change (RUMBO.md, cambio 11). Not part of upstream.
//
// The ✨ draft button in the inbox:
//   1. When the thread ends with OUR message (bot or agent), the model
//      got a transcript ending in an assistant turn, and Claude models
//      reject that (no assistant prefill) → "provider API error (400)".
//      `transcriptForDraft` adds a short internal user note so the model
//      writes the next message from where the thread stopped.
//   2. The draft now gets the same private payment link as the live bot:
//      if the draft carries `{{ENLACE_PAGO}}` (or an order without it),
//      the link is created on the platform and put in the draft.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from '@/lib/ai/types'
import { parseBotOutput } from '@/lib/ai/bot-output'
import { withCheckoutLink } from './checkout-link'

export const DRAFT_NUDGE =
  '[Nota interna del equipo, no la escribió el cliente: la conversación quedó en nuestro último mensaje. ' +
  'Escribe el mensaje que sigue, continuando donde quedó. Si quedó pendiente algo que le ofrecimos ' +
  '(por ejemplo, su enlace de pago), envíalo ahora completo.]'

/** The transcript for a draft: never ending in an assistant turn. */
export function transcriptForDraft(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0 || messages[messages.length - 1].role === 'user') return messages
  return [...messages, { role: 'user', content: DRAFT_NUDGE }]
}

/**
 * The draft text for the composer: the reply's messages joined, control
 * lines dropped, and the payment link created when the reply asks for it.
 * `db` must be the service-role client (the conversation is already
 * checked against the caller's account by the route).
 */
export async function draftWithLink(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  raw: string,
): Promise<string> {
  const parts = parseBotOutput(raw).messages
  try {
    const { data } = await db
      .from('conversations')
      .select('contact_id, channel')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    const conv = data as { contact_id: string | null; channel: string | null } | null
    if (conv?.contact_id) {
      const filled = await withCheckoutLink(db, { accountId, conversationId, contactId: conv.contact_id }, raw, parts, conv.channel)
      return filled.join('\n\n')
    }
  } catch (err) {
    console.warn('[rumbo] draft payment link skipped:', err)
  }
  return parts.join('\n\n')
}
