// Rumbo a la U — local change (see RUMBO.md).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fillLink, LINK_FALLBACK, parsePedido, requestedMedia, withCheckoutLink } from './checkout-link'
import { parseBotOutput } from '@/lib/ai/bot-output'

vi.mock('@/lib/notifications/telegram', () => ({
  isTelegramConfigured: () => false,
  sendTelegramText: vi.fn(),
}))

const RAW = [
  '🧾 *Resumen de su compra*',
  '[[NUEVO_MENSAJE]]',
  'Aquí tiene su enlace de pago privado: {{ENLACE_PAGO}}',
  'Vale hasta el {{ENLACE_PAGO_VENCE}}.',
  '[[PEDIDO|programa=SIMADI|producto=Paquete completo|plan=2 partes|area=Ciencias de la Salud]]',
  '[[ENVIAR:corto_simadi]]',
  '[[ETIQUETA:datos_pago_enviados]]',
].join('\n')

describe('Rumbo checkout link', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.RUMBO_CHECKOUT_SECRET
  })

  it('the control lines never reach the customer', () => {
    const { messages } = parseBotOutput(RAW)
    expect(messages.join('\n')).not.toMatch(/\[\[|PEDIDO|ENVIAR/)
    expect(messages.join('\n')).toContain('{{ENLACE_PAGO}}')
  })

  it('reads the order and the requested media', () => {
    expect(parsePedido(RAW)).toEqual({ programa: 'SIMADI', producto: 'Paquete completo', plan: '2 partes', area: 'Ciencias de la Salud' })
    expect(parsePedido('sin pedido')).toBeNull()
    expect(requestedMedia(RAW)).toEqual(['corto_simadi'])
    expect(requestedMedia('[[ENVIAR:a_b_c]] [[ENVIAR:a_b_c]] [[ENVIAR:x_y_z]] [[ENVIAR:q_q_q]]')).toEqual(['a_b_c', 'x_y_z'])
  })

  it('fills the link, or replaces its line with a polite fallback', () => {
    const parts = parseBotOutput(RAW).messages
    const filled = fillLink(parts, { url: 'https://rumbouni.com/pagar/abc', validUntil: 'viernes 20 de noviembre' })
    expect(filled[1]).toContain('https://rumbouni.com/pagar/abc')
    expect(filled[1]).toContain('viernes 20 de noviembre')
    const fallback = fillLink(parts, null)
    expect(fallback[1]).toContain(LINK_FALLBACK)
    expect(fallback.join('\n')).not.toContain('{{')
  })

  it('without the shared secret it never calls the platform and falls back', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { phone: '584121234567', name: 'Ana' } }) }) }) }) }) }
    const out = await withCheckoutLink(db as never, { accountId: 'a', conversationId: 'c', contactId: 'k' }, RAW, parseBotOutput(RAW).messages, 'whatsapp')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(out.join('\n')).toContain(LINK_FALLBACK)
  })

  it('with the secret it sends the order (not an amount) and uses the returned link', async () => {
    process.env.RUMBO_CHECKOUT_SECRET = 'x'.repeat(40)
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ url: 'https://rumbouni.com/pagar/TOKEN', vence_texto: 'viernes 20 de noviembre' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { phone: '584121234567', name: 'Ana' } }) }) }) }) }) }
    const out = await withCheckoutLink(db as never, { accountId: 'a', conversationId: 'c', contactId: 'k' }, RAW, parseBotOutput(RAW).messages, 'whatsapp')
    expect(out[1]).toContain('https://rumbouni.com/pagar/TOKEN')
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/crm\/checkout$/)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'x'.repeat(40)}`)
    const sent = JSON.parse(String(init.body))
    expect(sent).toMatchObject({ programa: 'SIMADI', plan: '2 partes', phone: '+584121234567', channel: 'whatsapp' })
    expect(sent).not.toHaveProperty('monto')
  })
})
