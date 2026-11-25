// Rumbo a la U — local change (RUMBO.md, cambio 14).
import { describe, expect, it } from 'vitest'
import { STICKER_LABEL, stickerLabel } from './instagram-sticker'
import { parseInstagramWebhook } from '@/lib/instagram/webhook-parse'

const IG = '17841467678140076'
const CLIENTE = '1234567890'
const mensaje = (attachments: unknown[]) =>
  parseInstagramWebhook({
    entry: [{ id: IG, messaging: [{ sender: { id: CLIENTE }, recipient: { id: IG }, timestamp: 1, message: { mid: 'm1', attachments } }] }],
  } as never)[0]

describe('Rumbo: stickers de Instagram', () => {
  it('reconoce un sticker o un GIF por su tipo o por su sticker_id', () => {
    expect(stickerLabel({ type: 'sticker' })).toBe(STICKER_LABEL)
    expect(stickerLabel({ type: 'animated_image' })).toBe(STICKER_LABEL)
    expect(stickerLabel({ type: 'image', payload: { sticker_id: 369239263222822 } })).toBe(STICKER_LABEL)
    expect(stickerLabel({ type: 'image', payload: { url: 'https://x/y.jpg' } })).toBeNull()
    expect(stickerLabel(undefined)).toBeNull()
  })

  it('el mensaje del sticker lleva «[Sticker]» y sigue siendo una imagen en la bandeja', () => {
    const ev = mensaje([{ type: 'image', payload: { url: 'https://cdn/x.webp', sticker_id: 123 } }])
    expect(ev).toMatchObject({ kind: 'message', contentType: 'image', text: STICKER_LABEL })
  })

  it('una foto normal no cambia', () => {
    const ev = mensaje([{ type: 'image', payload: { url: 'https://cdn/captura.jpg' } }])
    expect(ev).toMatchObject({ kind: 'message', contentType: 'image', text: null })
  })
})
