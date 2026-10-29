/**
 * Inbound messages Meta delivers as `type: "unsupported"` (error 131051,
 * "Message type unknown"): WhatsApp knows a message arrived but won't hand
 * us its content. In practice this is very often the first message a
 * customer sends from a Click-to-WhatsApp ad, or a newer message format
 * (polls, view-once media, edited messages…).
 *
 * Stored with a readable placeholder for the inbox, and rendered for the AI
 * as an explicit note — the raw "[Unsupported message type: unsupported]"
 * read like gibberish to the model, which then handed the thread to a human.
 */

/** `messages[].referral` of a Click-to-WhatsApp ad or post. */
export interface MetaReferral {
  /** 'ad' or 'post' */
  source_type?: string
  /** The ad id (ads) or post id. */
  source_id?: string
  /** Link to the ad/post — tells Facebook from Instagram. */
  source_url?: string
  headline?: string
  body?: string
  /** Click id of the ad click (Conversions API). */
  ctwa_clid?: string
}

const STORED_PREFIX = '[Mensaje que WhatsApp no deja ver aquí'
const LEGACY_PATTERN = /^\[Unsupported message type: [^\]]*\]$/

/** Stored `content_text` for an unsupported inbound (shown in the inbox). */
export function unsupportedInboundText(referral?: MetaReferral | null): string {
  const ad = adTitle(referral)
  return ad
    ? `${STORED_PREFIX} — llegó desde el anuncio «${ad}»]`
    : `${STORED_PREFIX} — revísalo en el teléfono]`
}

/** True for the stored placeholder, including rows saved before this change. */
export function isUnsupportedInboundText(text: string | null | undefined): boolean {
  const t = text?.trim() ?? ''
  return t.startsWith(STORED_PREFIX) || LEGACY_PATTERN.test(t)
}

/** What the model sees in place of the placeholder. */
export function unsupportedInboundForModel(storedText: string | null | undefined): string {
  const ad = storedText?.match(/anuncio «(.+)»\]$/)?.[1]
  return (
    '[The customer sent a message that WhatsApp does not let us read. This usually happens ' +
    'with the first message sent from an ad, or with a new message format. Its content is unknown.' +
    (ad ? ` It came from the ad "${ad}".` : '') +
    ' If it opens the conversation, treat it as a first contact asking for information and answer ' +
    'with the usual first-contact message. Never hand off to a human because of it; only if you truly ' +
    'need their question, ask them in one short sentence to write it.]'
  )
}

function adTitle(referral?: MetaReferral | null): string | null {
  if (!referral) return null
  const title = (referral.headline || referral.body || '').replace(/\s+/g, ' ').trim()
  if (!title) return referral.source_type === 'ad' ? 'Anuncio' : null
  return title.length > 80 ? `${title.slice(0, 79)}…` : title
}
