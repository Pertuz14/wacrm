// ============================================================
// Rumbo a la U — local change (RUMBO.md, cambio 16). Not part of upstream.
//
// The comment → DM claim is per comment, so a person who comments two posts
// gets the automatic DM twice (24-nov: two posts, 6 minutes apart, while she
// was already chatting with the bot). The automatic DM now goes out at most
// once per person every 24 hours, and never to someone who wrote to us by
// DM in the last 24 hours (the conversation is already going).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

const VENTANA_MS = 24 * 60 * 60_000

type Reclamo = { id: string; comment_id: string; created_at: string }

/** Did an earlier comment from this person already get (or claim) the DM? (pure, for the tests) */
export function yaRecibioElDm(propio: Reclamo, otros: Reclamo[]): boolean {
  const t = Date.parse(propio.created_at)
  return otros.some((o) => {
    if (o.comment_id === propio.comment_id) return false
    const to = Date.parse(o.created_at)
    return to < t || (to === t && o.id < propio.id)
  })
}

/**
 * True when the automatic DM for this (already claimed) comment should not go out.
 * Fails open (false → send as before) on any lookup problem.
 */
export async function omitirDmDeComentario(
  db: SupabaseClient,
  accountId: string,
  fromId: string,
  commentId: string,
): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - VENTANA_MS).toISOString()
    const { data: reclamos } = await db
      .from('instagram_comment_replies')
      .select('id, comment_id, created_at')
      .eq('account_id', accountId)
      .eq('from_id', fromId)
      .gte('created_at', desde)
      .limit(50)
    const filas = (reclamos ?? []) as Reclamo[]
    const propio = filas.find((f) => f.comment_id === commentId)
    if (propio && yaRecibioElDm(propio, filas)) return true

    // Already chatting by DM in the last 24 h: the bot is answering there.
    const { data: contacto } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('ig_user_id', fromId)
      .maybeSingle()
    const contactId = (contacto as { id: string } | null)?.id
    if (!contactId) return false
    const { data: convs } = await db.from('conversations').select('id').eq('contact_id', contactId).limit(10)
    const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id)
    if (convIds.length === 0) return false
    const { data: recientes } = await db
      .from('messages')
      .select('id')
      .in('conversation_id', convIds)
      .eq('sender_type', 'customer')
      .gte('created_at', desde)
      .limit(1)
    return Boolean(recientes && recientes.length > 0)
  } catch (err) {
    console.warn('[rumbo] comment DM check skipped:', err)
    return false
  }
}
