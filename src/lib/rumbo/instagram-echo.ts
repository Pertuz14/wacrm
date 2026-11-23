// ============================================================
// Rumbo a la U — local change (RUMBO.md, cambio 12). Not part of upstream.
//
// Instagram caps a DM at 1000 characters, so a long CRM message goes out
// in several parts (splitForInstagram). The row in `messages` keeps only
// the LAST part's mid, so the echoes of the earlier parts were not
// recognised and the inbox showed them again as new messages (22-nov:
// the payment link appeared twice, once without its bold).
// An echo is a part of our own recent send when its text is inside that
// message, split the same way it was sent (without WhatsApp markers).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { splitForInstagram } from '@/lib/instagram/send'
import { textoSinFormato } from './whatsapp-format'

const VENTANA_MS = 3 * 60_000

const plano = (t: string) => textoSinFormato(t).replace(/\s+/g, ' ').trim()

/**
 * Is this echoed text one of the parts of one of these sent messages? (pure, for the tests)
 * The message is split exactly as `sendInstagramToContact` split it, and only a message that
 * really went out in several parts counts: a short reply typed in the Instagram app is never hidden.
 */
export function esParteDeLoEnviado(eco: string, enviados: (string | null)[]): boolean {
  const e = plano(eco)
  if (!e) return false
  return enviados.some((m) => {
    if (!m) return false
    const partes = splitForInstagram(textoSinFormato(m))
    return partes.length > 1 && partes.some((p) => plano(p) === e)
  })
}

/** True when the echo is an earlier part of a long message the CRM itself sent a moment ago. */
export async function ecoDeEnvioPartido(
  db: SupabaseClient,
  conversationId: string,
  eco: string | null | undefined,
  timestamp: number,
): Promise<boolean> {
  if (!eco?.trim()) return false
  try {
    const { data } = await db
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .in('sender_type', ['agent', 'bot'])
      .gte('created_at', new Date(timestamp - VENTANA_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(10)
    const filas = (data ?? []) as { content_text: string | null }[]
    return esParteDeLoEnviado(eco, filas.map((f) => f.content_text))
  } catch (err) {
    console.warn('[rumbo] instagram echo check skipped:', err)
    return false
  }
}
