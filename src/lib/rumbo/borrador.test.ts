// Rumbo a la U — local change (RUMBO.md, cambio 11).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_NUDGE, draftWithLink, transcriptForDraft } from './borrador'

vi.mock('@/lib/notifications/telegram', () => ({
  isTelegramConfigured: () => false,
  sendTelegramText: vi.fn(),
}))

const db = (conv: { contact_id: string; channel: string } | null) => ({
  from: (table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === 'conversations' ? conv : { phone: null, name: 'Lourdes' } }),
        }),
      }),
    }),
  }),
})

describe('Rumbo ✨ draft', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.RUMBO_CHECKOUT_SECRET
  })

  it('never ends the transcript with our own message (Claude rejects it with a 400)', () => {
    const cliente = [{ role: 'user' as const, content: 'Me gustaría pagar de contado.' }]
    expect(transcriptForDraft(cliente)).toBe(cliente)
    const nuestro = [...cliente, { role: 'assistant' as const, content: 'Perfecto 🙌 Le preparo su enlace de pago privado.' }]
    const out = transcriptForDraft(nuestro)
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ role: 'user', content: DRAFT_NUDGE })
    expect(transcriptForDraft([])).toEqual([])
  })

  it('drops the control lines and puts the real payment link in the draft', async () => {
    process.env.RUMBO_CHECKOUT_SECRET = 'x'.repeat(40)
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ url: 'https://rumbouni.com/pagar/TOKEN', vence_texto: 'martes 24 de noviembre' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    const raw = '🧾 *Resumen de su compra*\n👇 *Su enlace de pago privado:*\n{{ENLACE_PAGO}}\n[[PEDIDO|programa=simadi|producto=Paquete completo|plan=contado|area=Salud y Agro y Mar]]\n[[ETIQUETA:datos_pago_enviados]]'
    const draft = await draftWithLink(db({ contact_id: 'k', channel: 'instagram' }) as never, 'a', 'c', raw)
    expect(draft).toContain('https://rumbouni.com/pagar/TOKEN')
    expect(draft).not.toMatch(/\[\[|\{\{/)
    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(sent).toMatchObject({ programa: 'simadi', plan: 'contado', channel: 'instagram', conversation_id: 'c', contact_id: 'k' })
  })

  it('a draft without an order is just the text, and never calls the platform', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const draft = await draftWithLink(db({ contact_id: 'k', channel: 'whatsapp' }) as never, 'a', 'c', 'Hola 😊\n[[NUEVO_MENSAJE]]\n¿En qué le ayudo?')
    expect(draft).toBe('Hola 😊\n\n¿En qué le ayudo?')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
