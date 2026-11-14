// Ad the customer came from (Meta click-to-WhatsApp or Instagram ad), as an internal line for the bot.
//
// The first message of a click-to-WhatsApp ad is often WhatsApp's own automatic text ("¡Hola! Quiero más
// información", or "Hello! Can I get more info on this?" when the phone is in English): it says nothing about
// the product. The ad's headline (stored by recordLeadSource in lead_sources.detail) does, so the bot reads it
// here and answers about that product, in Spanish.
import type { SupabaseClient } from '@supabase/supabase-js'

const AD_SOURCES = ['anuncio_meta', 'anuncio_instagram', 'anuncio_facebook']
const WINDOW_MS = 24 * 60 * 60 * 1000

/** Internal line for the system prompt (never shown to the customer). */
export const adContext = (headline: string | null) =>
  `[Contexto interno: la persona llegó tocando un anuncio de Meta${headline ? ` cuyo título es «${headline}»` : ''}. ` +
  'Su primer mensaje puede ser el texto automático de WhatsApp («Quiero más información», «Hello! Can I get more info on this?» u otro idioma): ' +
  'no es una pregunta concreta. Responde en español' +
  (headline
    ? ' y da la bienvenida directamente sobre el producto de ese anuncio (sin preguntar qué examen presenta si el título ya lo dice).]'
    : ' y pregunta para qué examen se prepara.]')

/** Headline of the ad that brought this conversation in the last 24 h, or undefined if it did not come from an ad. Never throws. */
export async function conversationAd(db: SupabaseClient, conversationId: string): Promise<{ headline: string | null } | undefined> {
  try {
    const { data, error } = await db
      .from('lead_sources')
      .select('detail, created_at')
      .eq('conversation_id', conversationId)
      .in('source', AD_SOURCES)
      // Only real ad clicks (with the ad's ID): a visit from the web by an ad stores the customer's own text as detail
      .not('ad_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) return undefined
    const row = (data ?? [])[0] as { detail: string | null; created_at: string } | undefined
    if (!row || Date.now() - Date.parse(row.created_at) > WINDOW_MS) return undefined
    return { headline: row.detail?.trim() || null }
  } catch {
    return undefined
  }
}
