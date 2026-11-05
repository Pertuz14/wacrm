import { describe, it, expect } from 'vitest'
import { readSchoolRef, schoolRefContext, stripSchoolRef } from './school-ref'
import { classifyMessageMarker } from './source'
import { renderMessageForModel } from '@/lib/ai/context'

// Mark of 'k7m2qx4' exactly as rumbouni.com writes it (web/simadi/src/public/js/marca-ref.js)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const DIGITS = ['​', '‌', '‍', '⁠']
function encode(code: string): string {
  const d = [...code].flatMap((c) => {
    const i = ALPHABET.indexOf(c)
    return [(i >> 4) & 3, (i >> 2) & 3, i & 3]
  })
  return DIGITS[3] + DIGITS[3] + d.map((x) => DIGITS[x]).join('') + DIGITS[d.reduce((s, x) => s + x, 0) % 4]
}
const MESSAGE = `Hola, quiero el paquete completo de preparación para el SIMADI (vi la web)${encode('k7m2qx4')}`

describe('allied-school mark', () => {
  it('reads the code and leaves the visible text untouched', () => {
    expect(readSchoolRef(MESSAGE)).toBe('k7m2qx4')
    expect(stripSchoolRef(MESSAGE)).toBe('Hola, quiero el paquete completo de preparación para el SIMADI (vi la web)')
  })

  it('ignores messages without a mark, broken marks and stray zero-width spaces', () => {
    expect(readSchoolRef('Hola (vi la web)')).toBeNull()
    expect(readSchoolRef(MESSAGE.slice(0, -2))).toBeNull()
    expect(readSchoolRef('hola​ mundo‍')).toBeNull()
    expect(readSchoolRef(null)).toBeNull()
  })

  it('still counts "(vi la web)" as the website when the mark follows it', () => {
    expect(classifyMessageMarker(MESSAGE)?.source).toBe('web')
  })

  it('never shows the invisible mark to the model', () => {
    const text = renderMessageForModel({ sender_type: 'customer', content_type: 'text', content_text: MESSAGE })
    expect(text).toBe('Hola, quiero el paquete completo de preparación para el SIMADI (vi la web)')
  })

  it('builds the internal line the bot prompt expects', () => {
    expect(schoolRefContext('k7m2qx4')).toBe('[Contexto interno: llegó por el enlace de un colegio aliado · código k7m2qx4]')
  })
})
