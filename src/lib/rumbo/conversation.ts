// ============================================================
// Rumbo a la U — local change (see RUMBO.md). Not part of upstream.
//
// Resolve an existing conversation of the account by id, for
// POST /api/v1/messages `conversation_id` (Instagram threads have no
// phone to resolve by). Same shape as resolveConversationByPhone.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResolvedConversation } from '@/lib/whatsapp/resolve-conversation'
import { SendMessageError } from '@/lib/whatsapp/send-message'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function conversationOfAccount(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<ResolvedConversation> {
  const { data } = await db
    .from('conversations')
    .select('id, contact_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  const row = data as { id: string; contact_id: string } | null
  if (!row) throw new SendMessageError('not_found', 'Conversation not found', 404)
  return { conversationId: row.id, contactId: row.contact_id, contactCreated: false, conversationCreated: false }
}
