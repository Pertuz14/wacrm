import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { piezasWhatsApp } from './whatsapp-format'
import { LinkifyText } from '@/lib/inbox/linkify-text'

const plano = (texto: string) =>
  piezasWhatsApp(texto).map((p) => `${p.negrita ? 'B' : ''}${p.cursiva ? 'I' : ''}${p.tachado ? 'S' : ''}[${p.texto}]`).join('')

describe('piezasWhatsApp (formato de WhatsApp en la bandeja)', () => {
  it('pone negrita, cursiva y tachado sin las marcas', () => {
    expect(plano('🧾 *Resumen de su compra*')).toBe('[🧾 ]B[Resumen de su compra]')
    expect(plano('Es _muy_ fácil y ~caro~ barato')).toBe('[Es ]I[muy][ fácil y ]S[caro][ barato]')
  })

  it('cierra antes de la puntuación y permite marcas anidadas', () => {
    expect(plano('vale hasta el *domingo 22 de noviembre*.')).toBe('[vale hasta el ]B[domingo 22 de noviembre][.]')
    expect(plano('💵 *Monto a pagar:* 55 USD')).toBe('[💵 ]B[Monto a pagar:][ 55 USD]')
    expect(plano('*_importante_*')).toBe('BI[importante]')
  })

  it('el mensaje del enlace de pago: cada línea por su cuenta y el enlace intacto', () => {
    const m20 = '👇 *Su enlace de pago privado:*\nhttps://rumbouni.com/pagar/Zg_R7~Dyn_wS7*Rb*cd\n\n*¿Cómo funciona?*'
    expect(plano(m20)).toBe('[👇 ]B[Su enlace de pago privado:][\n][https://rumbouni.com/pagar/Zg_R7~Dyn_wS7*Rb*cd][\n\n]B[¿Cómo funciona?]')
  })

  it('en la bandeja: negrita sin asteriscos y el enlace de pago sigue siendo un enlace completo', () => {
    const html = renderToStaticMarkup(createElement(LinkifyText, {
      text: '💵 *Monto a pagar:* 55 USD\n👇 *Su enlace de pago privado:*\nhttps://rumbouni.com/pagar/ZgR7_Dyn~wS7',
      isAgent: true,
    }))
    expect(html).toContain('<strong class="font-semibold">Monto a pagar:</strong>')
    expect(html).toContain('<strong class="font-semibold">Su enlace de pago privado:</strong>')
    expect(html).toContain('href="https://rumbouni.com/pagar/ZgR7_Dyn~wS7"')
    expect(html).not.toMatch(/\*Monto|pagar:\*/)
  })

  it('no formatea lo que WhatsApp tampoco formatea', () => {
    expect(plano('2 * 3 * 4')).toBe('[2 * 3 * 4]') // marcas con espacio por dentro
    expect(plano('snake_case_name')).toBe('[snake_case_name]') // dentro de una palabra
    expect(plano('*abre\ncierra*')).toBe('[*abre\ncierra*]') // en dos líneas
    expect(plano('**')).toBe('[**]')
    expect(plano('')).toBe('')
  })
})
