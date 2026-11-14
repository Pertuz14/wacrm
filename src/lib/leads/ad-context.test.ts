import { describe, expect, it } from 'vitest'
import { adContext } from './ad-context'

describe('adContext', () => {
  it('names the ad headline and asks for a Spanish welcome about that product', () => {
    const line = adContext('Prepárate para el Propedéutico UCV')
    expect(line).toContain('«Prepárate para el Propedéutico UCV»')
    expect(line).toContain('Responde en español')
    expect(line).toContain('sin preguntar qué examen')
  })
  it('without a headline asks which exam', () => {
    expect(adContext(null)).toContain('pregunta para qué examen se prepara')
  })
})
