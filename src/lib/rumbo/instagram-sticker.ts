// ============================================================
// Rumbo a la U — local change (RUMBO.md, cambio 14). Not part of upstream.
//
// An Instagram sticker or GIF reached the bot as «The customer sent an
// image», and after the payment link the bot took a sticker for a payment
// receipt (22-nov: it asked for the registration and sent the Telegram
// alert). When Meta marks the attachment as a sticker or a GIF, the message
// now carries the text «[Sticker]», which the inbox and the bot both see.
// ============================================================

export const STICKER_LABEL = '[Sticker]'

interface Adjunto {
  type?: string
  payload?: { sticker_id?: string | number | null } & Record<string, unknown>
}

/** «[Sticker]» for a sticker or GIF attachment; null for anything else. */
export function stickerLabel(a: Adjunto | undefined): string | null {
  if (!a) return null
  if (a.type === 'sticker' || a.type === 'animated_image') return STICKER_LABEL
  const id = a.payload?.sticker_id
  return id !== undefined && id !== null && String(id).trim() ? STICKER_LABEL : null
}
