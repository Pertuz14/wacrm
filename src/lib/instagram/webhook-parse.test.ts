import { describe, expect, it } from 'vitest'
import {
  attachmentContentType,
  isInsideWindow,
  matchCommentKeyword,
  parseInstagramWebhook,
} from './webhook-parse'
import { splitForInstagram } from './send'
import { verifySignatureWithSecrets } from '@/lib/whatsapp/webhook-signature'
import crypto from 'node:crypto'

const IG = '17841467678140076'
const CUSTOMER = '1234567890'

describe('parseInstagramWebhook', () => {
  it('reads a text DM from a customer', () => {
    const events = parseInstagramWebhook({
      object: 'instagram',
      entry: [{ id: IG, messaging: [{ sender: { id: CUSTOMER }, recipient: { id: IG }, timestamp: 1700000000000, message: { mid: 'm1', text: 'Hola, ¿cuánto cuesta?' } }] }],
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'message', customerId: CUSTOMER, isEcho: false, mid: 'm1', text: 'Hola, ¿cuánto cuesta?', contentType: 'text' })
  })

  it('treats an echo as sent by the business and keeps the customer as the recipient', () => {
    const [ev] = parseInstagramWebhook({
      entry: [{ id: IG, messaging: [{ sender: { id: IG }, recipient: { id: CUSTOMER }, timestamp: 1, message: { mid: 'm2', text: 'Respuesta', is_echo: true } }] }],
    })
    expect(ev).toMatchObject({ kind: 'message', isEcho: true, customerId: CUSTOMER })
  })

  it('maps attachments to inbox content types', () => {
    const [ev] = parseInstagramWebhook({
      entry: [{ id: IG, messaging: [{ sender: { id: CUSTOMER }, recipient: { id: IG }, message: { mid: 'm3', attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] } }] }],
    })
    expect(ev).toMatchObject({ contentType: 'image', mediaUrl: 'https://cdn/x.jpg' })
    expect(attachmentContentType('ig_reel')).toBe('video')
    expect(attachmentContentType('file')).toBe('document')
    expect(attachmentContentType('share')).toBe('text')
  })

  it('describes shares and story replies in text', () => {
    const [share, story] = parseInstagramWebhook({
      entry: [{ id: IG, messaging: [
        { sender: { id: CUSTOMER }, recipient: { id: IG }, message: { mid: 'm4', attachments: [{ type: 'share', payload: { url: 'https://instagram.com/p/x' } }] } },
        { sender: { id: CUSTOMER }, recipient: { id: IG }, message: { mid: 'm5', text: '¡Qué bueno!', reply_to: { story: { url: 'https://cdn/story', id: 's1' } } } },
      ] }],
    })
    expect(share).toMatchObject({ contentType: 'text', mediaUrl: null })
    expect((share as { text: string }).text).toContain('https://instagram.com/p/x')
    expect(story).toMatchObject({ storyReplyUrl: 'https://cdn/story' })
  })

  it('reads reactions and comments, skipping our own comments', () => {
    const events = parseInstagramWebhook({
      entry: [{
        id: IG,
        messaging: [{ sender: { id: CUSTOMER }, recipient: { id: IG }, reaction: { mid: 'm1', action: 'react', reaction: 'love' } }],
        changes: [
          { field: 'comments', value: { id: 'c1', text: 'GUÍA por favor', from: { id: CUSTOMER, username: 'ana' }, media: { id: 'p1' } } },
          { field: 'comments', value: { id: 'c2', text: 'Gracias', from: { id: IG, username: 'rumbou.ve' }, media: { id: 'p1' } } },
        ],
      }],
    })
    expect(events.map((e) => e.kind)).toEqual(['reaction', 'comment'])
    expect(events[0]).toMatchObject({ emoji: '❤️', removed: false })
    expect(events[1]).toMatchObject({ commentId: 'c1', fromUsername: 'ana', mediaId: 'p1' })
  })

  it('ignores entries without an account id or messages without a mid', () => {
    expect(parseInstagramWebhook({ entry: [{ messaging: [{ message: { mid: 'x' } }] }] })).toEqual([])
    expect(parseInstagramWebhook({ entry: [{ id: IG, messaging: [{ sender: { id: CUSTOMER }, read: { mid: 'm1' } }] }] })).toEqual([])
  })
})

describe('matchCommentKeyword', () => {
  it('ignores case, accents and punctuation, and matches whole words', () => {
    expect(matchCommentKeyword('¡GUÍA!', ['guia'])).toBe('guia')
    expect(matchCommentKeyword('quiero la guia por favor', ['GUIA'])).toBe('GUIA')
    expect(matchCommentKeyword('guiado', ['guia'])).toBeNull()
    expect(matchCommentKeyword('más info', ['simulacro', 'mas info'])).toBe('mas info')
    expect(matchCommentKeyword('hola', [])).toBeNull()
  })
})

describe('isInsideWindow', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  it('is open for 24 hours after the last customer message', () => {
    expect(isInsideWindow('2026-10-17T00:00:00Z', now)).toBe(true)
    expect(isInsideWindow('2026-10-16T11:59:00Z', now)).toBe(false)
    expect(isInsideWindow(null, now)).toBe(false)
  })
})

describe('splitForInstagram', () => {
  it('keeps short texts whole and splits long ones under the limit', () => {
    expect(splitForInstagram('hola')).toEqual(['hola'])
    const long = `${'a'.repeat(700)}. ${'b'.repeat(700)}`
    const parts = splitForInstagram(long, 1000)
    expect(parts.length).toBe(2)
    expect(parts.every((p) => p.length <= 1000)).toBe(true)
    expect(parts.join(' ').replace(/\s/g, '')).toBe(long.replace(/\s/g, ''))
  })
})

describe('verifySignatureWithSecrets', () => {
  it('accepts a body signed with any of the secrets', () => {
    const body = '{"object":"instagram"}'
    const sig = 'sha256=' + crypto.createHmac('sha256', 'ig-secret').update(body).digest('hex')
    expect(verifySignatureWithSecrets(body, sig, ['other', 'ig-secret'])).toBe(true)
    expect(verifySignatureWithSecrets(body, sig, ['other'])).toBe(false)
    expect(verifySignatureWithSecrets(body, null, ['ig-secret'])).toBe(false)
    expect(verifySignatureWithSecrets(body, sig, [])).toBe(false)
  })
})
