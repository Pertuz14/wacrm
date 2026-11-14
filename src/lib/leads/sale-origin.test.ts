import { describe, expect, it } from 'vitest'
import { pickSaleOrigin } from './sale-origin'
import { properName } from '@/lib/text/proper-name'

const row = (source: string, created_at: string, detail: string | null = null, ad_id: string | null = null) => ({ source, created_at, detail, ad_id })

describe('pickSaleOrigin', () => {
  it('prefers the latest real origin over a later plain WhatsApp message', () => {
    const o = pickSaleOrigin([
      row('whatsapp', '2026-11-01T10:00:00Z'),
      row('anuncio_meta', '2026-11-10T10:00:00Z', 'Vas al Propedéutico', '123'),
      row('whatsapp', '2026-11-12T10:00:00Z'),
    ])
    expect(o).toEqual({ source: 'anuncio_meta', label: 'Anuncio de Meta', detail: 'Vas al Propedéutico', adId: '123' })
  })
  it('falls back to WhatsApp directo when there is nothing else', () => {
    expect(pickSaleOrigin([row('whatsapp', '2026-11-01T10:00:00Z')])?.label).toBe('WhatsApp directo')
  })
  it('unknown sources count as «Otro»; no rows → null', () => {
    expect(pickSaleOrigin([row('nuevo', '2026-11-01T10:00:00Z')])?.source).toBe('otro')
    expect(pickSaleOrigin([])).toBeNull()
  })
})

describe('properName', () => {
  it('capitalizes initials and keeps particles lowercase', () => {
    expect(properName('andrea gonzález')).toBe('Andrea González')
    expect(properName('  MARÍA JOSÉ  DE LA ROSA ')).toBe('María José de la Rosa')
    expect(properName("ana-maría d'angelo")).toBe("Ana-María D'Angelo")
    expect(properName('maría del valle')).toBe('María del Valle')
    expect(properName(null)).toBe('')
  })
})
