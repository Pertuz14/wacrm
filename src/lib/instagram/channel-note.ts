import type { SupabaseClient } from '@supabase/supabase-js'

/** Default note appended to the AI prompt for Instagram Direct conversations. */
export const DEFAULT_INSTAGRAM_CHANNEL_NOTE =
  'CANAL: esta conversación llega por mensaje directo de Instagram, no por WhatsApp. Responde en mensajes cortos, con el mismo trato y las mismas reglas. Por aquí no se reciben pagos ni comprobantes: cuando la persona quiera comprar, pagar o enviar un comprobante, invítala a escribir al WhatsApp de la marca.'

/** The account's note (Settings → Instagram), or the default one. Never throws. */
export async function instagramChannelNote(db: SupabaseClient, accountId: string): Promise<string> {
  try {
    const { data } = await db.from('instagram_config').select('ai_channel_note').eq('account_id', accountId).maybeSingle()
    const note = (data as { ai_channel_note?: string | null } | null)?.ai_channel_note?.trim()
    return note || DEFAULT_INSTAGRAM_CHANNEL_NOTE
  } catch {
    return DEFAULT_INSTAGRAM_CHANNEL_NOTE
  }
}
