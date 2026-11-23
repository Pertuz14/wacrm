// Rumbo a la U — local change (RUMBO.md, cambio 12).
import { describe, expect, it } from 'vitest'
import { esParteDeLoEnviado } from './instagram-echo'
import { splitForInstagram } from '@/lib/instagram/send'
import { textoSinFormato } from './whatsapp-format'

// El enlace de pago de Lourdes (22-nov): 1189 caracteres → 2 partes en Instagram
const ENVIADO = [
  'Aquí tiene su enlace de pago privado 👇',
  '',
  '🧾 *Resumen de su compra*',
  '',
  '📘 Producto: Paquete completo (guías, banco y simulacros)',
  '🎯 Área: Salud, Agro y Mar',
  '🗓️ Plan: Contado',
  '💵 *Monto a pagar:* 55 USD (o su equivalente en bolívares a la tasa BCV del día en que pague)',
  '',
  '👇 *Su enlace de pago privado:*',
  'https://rumbouni.com/pagar/lYeMLj_Ab~Cd*Ef*Gh',
  '',
  '*¿Cómo funciona?*',
  '1️⃣ Abra el enlace y elija cómo pagar: Pago Móvil, Binance, Zinli o transferencia ACH.',
  '2️⃣ Copie los datos con un toque (en Pago Móvil, todos de una vez) y haga el pago en su banco o app.',
  '3️⃣ En el mismo enlace, envíenos la captura del pago y los datos del estudiante. No hace falta llenar ningún registro por aquí.',
  '4️⃣ Verificamos su pago (en promedio, unos 15 minutos) y le llegan por correo y por WhatsApp los pasos para entrar a su plataforma.',
  '',
  '⚡ *Con Pago Móvil, al instante:* pague el monto exacto que le muestra el enlace (con los céntimos) y escriba bien la referencia y el teléfono desde el que pagó.',
  '',
  '⚠️ Use un correo al que tenga acceso permanente: al entrar a la plataforma le llega un código a ese correo.',
  '🔒 El enlace es solo para usted y vale hasta el miércoles 25 de noviembre.',
].join('\n')

describe('Rumbo: ecos de Instagram de un mensaje partido', () => {
  const partes = splitForInstagram(textoSinFormato(ENVIADO))

  it('el mensaje de prueba sale en varias partes, como el real', () => {
    expect(ENVIADO.length).toBeGreaterThan(1000)
    expect(partes.length).toBeGreaterThan(1)
  })

  it('el eco de una parte anterior se reconoce (sin asteriscos y con otros espacios)', () => {
    expect(esParteDeLoEnviado(partes[0], [ENVIADO])).toBe(true)
    expect(esParteDeLoEnviado(`  ${partes[0].replace(/\n/g, ' \n')}  `, ['Otro mensaje', ENVIADO])).toBe(true)
  })

  it('nunca esconde lo que se escribió desde la app de Instagram', () => {
    expect(esParteDeLoEnviado('Gracias', [ENVIADO])).toBe(false) // está dentro del mensaje, pero no es una parte
    expect(esParteDeLoEnviado('Perfecto 🙌', ['Perfecto 🙌'])).toBe(false) // un mensaje corto no se parte
    expect(esParteDeLoEnviado('', [ENVIADO])).toBe(false)
    expect(esParteDeLoEnviado(partes[0], [null, 'Hola'])).toBe(false)
  })
})
