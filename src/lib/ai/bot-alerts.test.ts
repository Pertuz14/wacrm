import { describe, it, expect } from 'vitest'
import { formatRegistroFields, localPhone } from './bot-alerts'

describe('formatRegistroFields', () => {
  it('lists the fields in the order of the access form, phone and channel included', () => {
    const text = formatRegistroFields(
      {
        nombre: 'Ivana Andara',
        correo: 'ivana@gmail.com',
        carreras: 'Medicina; Nutrición',
        area: 'Salud, Agro y Mar',
        producto: 'Paquete completo',
        plan: 'contado',
        ref6: '418774',
      },
      '584242172972',
    )
    expect(text.split('\n')).toEqual([
      'Correo: ivana@gmail.com',
      'Nombre: Ivana Andara',
      'Teléfono: 0424-2172972',
      'Área: Salud, Agro y Mar',
      'Canal: WhatsApp',
      'Productos: Paquete completo',
      'Plan de pago: contado',
      'Referencia: 418774',
      'Carreras: Medicina; Nutrición',
    ])
  })

  it('keeps foreign numbers international', () => {
    expect(localPhone('+14155550123')).toBe('+14155550123')
  })
})
