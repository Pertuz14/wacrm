// Rumbo a la U — local change (see RUMBO.md).
import { describe, expect, it } from 'vitest'
import { asksNoContact } from './after-reply'
import { parseBotOutput } from '@/lib/ai/bot-output'

describe('«No contactar»', () => {
  it('detects the control line and never shows it to the customer', () => {
    const raw = 'Entendemos perfectamente 😊 Le deseamos mucho éxito.\n[[NO_CONTACTAR]]'
    expect(asksNoContact(raw)).toBe(true)
    expect(asksNoContact('[[ no_contactar ]]')).toBe(true)
    expect(asksNoContact('Le escribimos luego')).toBe(false)
    expect(parseBotOutput(raw).messages.join('\n')).not.toContain('NO_CONTACTAR')
  })
})
