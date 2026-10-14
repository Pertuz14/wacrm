import { describe, it, expect } from 'vitest'
import {
  isUnsupportedInboundText,
  unsupportedInboundForModel,
  unsupportedInboundText,
} from './unsupported-message'

describe('unsupported inbound messages', () => {
  it('stores a readable placeholder, naming the ad when Meta sends one', () => {
    expect(unsupportedInboundText()).toBe('[Mensaje que WhatsApp no deja ver aquí — revísalo en el teléfono]')
    expect(unsupportedInboundText({ source_type: 'ad', headline: 'Prepárelo para el SIMADI 2027' })).toBe(
      '[Mensaje que WhatsApp no deja ver aquí — llegó desde el anuncio «Prepárelo para el SIMADI 2027»]',
    )
    expect(unsupportedInboundText({ source_type: 'ad' })).toContain('«Anuncio»')
  })

  it('recognises the new placeholder and the legacy one', () => {
    expect(isUnsupportedInboundText(unsupportedInboundText())).toBe(true)
    expect(isUnsupportedInboundText('[Unsupported message type: unsupported]')).toBe(true)
    expect(isUnsupportedInboundText('[Unsupported message type: poll]')).toBe(true)
    expect(isUnsupportedInboundText('hola')).toBe(false)
    expect(isUnsupportedInboundText(null)).toBe(false)
  })

  it('tells the model to treat it as a first contact and never to hand off', () => {
    const note = unsupportedInboundForModel('[Unsupported message type: unsupported]')
    expect(note).toContain('first contact')
    expect(note).toContain('Never hand off')
    expect(unsupportedInboundForModel(unsupportedInboundText({ headline: 'SIMADI' }))).toContain('ad "SIMADI"')
  })
})
