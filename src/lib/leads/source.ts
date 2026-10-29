import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetaReferral } from '@/lib/whatsapp/unsupported-message'

// ============================================================
// Where a customer came from (migration 055, table lead_sources).
//
// Recorded on the contact's first message ever, and again whenever a
// later message carries an origin of its own:
//   * WhatsApp: Meta's `referral` (Click-to-WhatsApp ad or post), or a
//     marker in the pre-filled text of our links — "(vi la web)",
//     "(vi TikTok)", "(vi Instagram)"… Any "(vi X)" at the end works.
//   * Instagram: an ad's referral, a DM that follows one of our
//     comment-to-DM replies, or a plain DM.
// Without any marker the first message counts as "WhatsApp directo" /
// "Instagram". Everything is best-effort — it must never break a reply.
// ============================================================

export type LeadSource =
  | 'anuncio_instagram'
  | 'anuncio_facebook'
  | 'anuncio_meta'
  | 'publicacion'
  | 'web'
  | 'tiktok'
  | 'instagram'
  | 'comentario_instagram'
  | 'facebook'
  | 'youtube'
  | 'whatsapp'
  | 'otro'
  | 'sin_dato'

/** Same labels as lead_source_label() in migration 055. */
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  anuncio_instagram: 'Anuncio de Instagram',
  anuncio_facebook: 'Anuncio de Facebook',
  anuncio_meta: 'Anuncio de Meta',
  publicacion: 'Publicación de Facebook o Instagram',
  web: 'Página web',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  comentario_instagram: 'Comentario en Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp directo',
  otro: 'Otro',
  sin_dato: 'Sin dato',
}

/** `messaging[].referral` (or `message.referral`) of an Instagram ad click. */
export interface IgReferral {
  ref?: string
  ad_id?: string
  source?: string
  type?: string
  ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string; post_id?: string }
}

export interface ClassifiedSource {
  source: LeadSource
  detail: string | null
  adId: string | null
  sourceUrl: string | null
  clickId: string | null
}

const clean = (s: string | null | undefined, max = 160): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const result = (source: LeadSource, detail: string | null = null, extra: Partial<ClassifiedSource> = {}): ClassifiedSource => ({
  source,
  detail,
  adId: null,
  sourceUrl: null,
  clickId: null,
  ...extra,
})

/** Origin from Meta's WhatsApp referral, or null without one. */
export function classifyWhatsAppReferral(referral: MetaReferral | null | undefined): ClassifiedSource | null {
  if (!referral || (!referral.source_type && !referral.source_id && !referral.source_url)) return null
  const url = (referral.source_url ?? '').toLowerCase()
  const detail = clean(referral.headline) ?? clean(referral.body)
  const extra = {
    adId: referral.source_id ?? null,
    sourceUrl: referral.source_url ?? null,
    clickId: referral.ctwa_clid ?? null,
  }
  if (referral.source_type === 'post') return result('publicacion', detail, extra)
  const source: LeadSource = url.includes('instagram')
    ? 'anuncio_instagram'
    : /facebook|fb\.(me|com)/.test(url)
      ? 'anuncio_facebook'
      : 'anuncio_meta'
  return result(source, detail, extra)
}

/** Origin from an Instagram DM's ad referral, or null without one. */
export function classifyInstagramReferral(referral: IgReferral | null | undefined): ClassifiedSource | null {
  if (!referral || (!referral.ad_id && referral.source !== 'ADS')) return null
  return result('anuncio_instagram', clean(referral.ads_context_data?.ad_title), { adId: referral.ad_id ?? null })
}

/** Known "(vi X)" names → origin. */
const MARKERS: [RegExp, LeadSource][] = [
  [/^(la )?(web|pagina( web)?|sitio( web)?|rumbouni(\.com)?)$/, 'web'],
  [/^(en )?tik ?tok$/, 'tiktok'],
  [/^(en )?(instagram|ig|insta)$/, 'instagram'],
  [/^(en )?(facebook|fb)$/, 'facebook'],
  [/^(en )?youtube$/, 'youtube'],
]

/**
 * Origin written in the message by one of our links: "(vi la web)",
 * "(vi TikTok)"… at the end of the text, or a plain TikTok mention.
 * The detail is what the person asked for (the text without the marker).
 */
export function classifyMessageMarker(text: string | null | undefined): ClassifiedSource | null {
  const raw = (text ?? '').trim()
  if (!raw) return null
  const match = raw.match(/\(\s*vi\s+([^()]{2,40}?)\s*\)\s*[.!]*\s*$/i)
  if (match) {
    const name = normalize(match[1]).trim()
    const asked = clean(raw.slice(0, match.index), 120)
    for (const [re, source] of MARKERS) if (re.test(name)) return result(source, asked)
    return result('otro', clean(match[1], 60))
  }
  if (/\btik ?tok\b/.test(normalize(raw))) return result('tiktok', clean(raw, 120))
  return null
}

export interface RecordLeadSourceArgs {
  accountId: string
  contactId: string
  conversationId: string
  /** Sender-of-record for the contact note (NOT NULL user_id). */
  userId: string
  channel: 'whatsapp' | 'instagram'
  /** The contact's first customer message in this conversation. */
  isFirstInbound: boolean
  text: string | null
  waReferral?: MetaReferral | null
  igReferral?: IgReferral | null
  /** Keyword of the comment-to-DM reply this DM answers, if any. */
  commentKeyword?: string | null
}

/** The origin of one inbound message, or null when it says nothing new. */
export function classifyInbound(args: Omit<RecordLeadSourceArgs, 'accountId' | 'contactId' | 'conversationId' | 'userId'>): ClassifiedSource | null {
  const explicit =
    (args.channel === 'whatsapp' ? classifyWhatsAppReferral(args.waReferral) : classifyInstagramReferral(args.igReferral)) ??
    (args.channel === 'instagram' && args.isFirstInbound && args.commentKeyword
      ? result('comentario_instagram', clean(args.commentKeyword, 60))
      : null) ??
    (args.channel === 'whatsapp' ? classifyMessageMarker(args.text) : null)
  if (explicit) return explicit
  if (!args.isFirstInbound) return null
  return result(args.channel === 'instagram' ? 'instagram' : 'whatsapp')
}

/** Contact note shown in the CRM, e.g. "📍 Origen: Anuncio de Instagram «…» (ID del anuncio 123)". */
export function originNote(c: ClassifiedSource): string {
  const parts = [`📍 Origen: ${LEAD_SOURCE_LABELS[c.source]}`]
  if (c.detail) parts.push(`«${c.detail}»`)
  if (c.adId) parts.push(`(ID del anuncio ${c.adId})`)
  return parts.join(' ')
}

/** Same origin again within this window is not a new arrival. */
const REPEAT_WINDOW_MS = 12 * 60 * 60 * 1000

/** Classify an inbound message and store its origin. Never throws. */
export async function recordLeadSource(db: SupabaseClient, args: RecordLeadSourceArgs): Promise<void> {
  try {
    const found = classifyInbound(args)
    if (!found) return

    const { data: prior, error: priorError } = await db
      .from('lead_sources')
      .select('source, detail, ad_id, created_at')
      .eq('contact_id', args.contactId)
      .order('created_at', { ascending: false })
      .limit(1)
    if (priorError) return // migration 055 not applied yet
    const last = (prior ?? [])[0] as { source: string; detail: string | null; ad_id: string | null; created_at: string } | undefined
    if (
      last &&
      last.source === found.source &&
      (last.ad_id ?? null) === found.adId &&
      Date.now() - Date.parse(last.created_at) < REPEAT_WINDOW_MS
    ) {
      return
    }
    // A plain first message of a contact we already know adds nothing.
    if (last && (found.source === 'whatsapp' || found.source === 'instagram') && !found.detail) return

    const { error } = await db.from('lead_sources').insert({
      account_id: args.accountId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      channel: args.channel,
      source: found.source,
      detail: found.detail,
      ad_id: found.adId,
      source_url: found.sourceUrl,
      click_id: found.clickId,
      first_message: clean(args.text, 500),
      is_first_touch: !last,
    })
    if (error) {
      console.error('[lead source] insert failed:', error.message)
      return
    }

    if (found.source !== 'whatsapp' && found.source !== 'instagram') {
      await db.from('contact_notes').insert({
        account_id: args.accountId,
        contact_id: args.contactId,
        user_id: args.userId,
        note_text: originNote(found),
      })
    }
  } catch (err) {
    console.error('[lead source] failed:', err)
  }
}
