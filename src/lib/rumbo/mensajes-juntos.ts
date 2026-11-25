// ============================================================
// Rumbo a la U — local change (RUMBO.md, cambio 15). Not part of upstream.
//
// WhatsApp stamps messages to the second. When a customer sends two
// messages at once (23-nov: «Hola, quiero información…» and a reel link),
// both rows share the exact same created_at, so neither dispatch saw the
// other as "newer" and the bot answered the same thing twice.
// Tie-break on the row id: of the messages that share the second, only the
// one with the highest id answers, and it sees all of them in the transcript.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Is there another message from the same second that wins the tie? (pure, for the tests) */
export function pierdeElEmpate(propioId: string, mismosSegundoIds: string[]): boolean {
  return mismosSegundoIds.some((id) => id !== propioId && id > propioId)
}

/**
 * True when another customer message with exactly the same created_at wins the tie, so
 * its own dispatch answers. Fails safe (false → reply anyway) on any lookup problem.
 */
export async function otroDelMismoSegundoResponde(
  db: SupabaseClient,
  conversationId: string,
  propio: { id: string; created_at: string },
  contentTypes: string[],
): Promise<boolean> {
  try {
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .in('content_type', contentTypes)
      .eq('created_at', propio.created_at)
      .limit(20)
    const ids = ((data ?? []) as { id: string }[]).map((f) => f.id)
    return pierdeElEmpate(propio.id, ids)
  } catch (err) {
    console.warn('[rumbo] same-second inbound check skipped:', err)
    return false
  }
}
