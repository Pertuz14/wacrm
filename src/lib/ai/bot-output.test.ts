import { describe, it, expect } from 'vitest'
import { MAX_MESSAGES_PER_TURN, hasAction, parseBotOutput } from './bot-output'

describe('parseBotOutput', () => {
  it('returns a plain reply as one message with no actions', () => {
    expect(parseBotOutput('Hola 👋\n\n¿A qué carrera aspira?')).toEqual({
      messages: ['Hola 👋\n\n¿A qué carrera aspira?'],
      actions: [],
    })
  })

  it('splits on [[NUEVO_MENSAJE]] lines into separate messages', () => {
    const raw = [
      '🧾 *Resumen de su compra*',
      'Paquete completo: 50 USD',
      '[[NUEVO_MENSAJE]]',
      '19684857',
      '04129558222',
      'Banco de Venezuela (0102)',
      '43782,53',
      '[[NUEVO_MENSAJE]]',
      '*REGISTRO*',
      'Nombre del estudiante:',
    ].join('\n')
    expect(parseBotOutput(raw).messages).toEqual([
      '🧾 *Resumen de su compra*\nPaquete completo: 50 USD',
      '19684857\n04129558222\nBanco de Venezuela (0102)\n43782,53',
      '*REGISTRO*\nNombre del estudiante:',
    ])
  })

  it('extracts the action tags and strips them from the text', () => {
    const raw = [
      '¡Gracias! 🙌 Estamos verificando el pago.',
      '[[ACCION:VERIFICAR_PAGO]]',
      '[[REGISTRO|nombre=Ana Pérez|correo=ana@gmail.com|carreras=Medicina; Odontología|ref6=123456]]',
      '[[ETIQUETA:pago_por_verificar]]',
    ].join('\n')
    const out = parseBotOutput(raw)
    expect(out.messages).toEqual(['¡Gracias! 🙌 Estamos verificando el pago.'])
    expect(out.actions).toEqual([
      { type: 'verify_payment' },
      {
        type: 'registro',
        fields: {
          nombre: 'Ana Pérez',
          correo: 'ana@gmail.com',
          carreras: 'Medicina; Odontología',
          ref6: '123456',
        },
      },
      { type: 'label', value: 'pago_por_verificar' },
    ])
  })

  it('reads the handoff reason, and treats [[HANDOFF]] as a handoff too', () => {
    expect(
      hasAction(
        parseBotOutput('Le paso.\n[[ACCION:PASAR_A_HUMANO|motivo=descuento]]').actions,
        'handoff',
      ),
    ).toEqual({ type: 'handoff', reason: 'descuento' })
    expect(parseBotOutput('[[HANDOFF]]')).toEqual({
      messages: [],
      actions: [{ type: 'handoff', reason: null }],
    })
  })

  it('strips tags a model appended mid-line, and splits on an inline separator', () => {
    const out = parseBotOutput('Listo ✅ [[ETIQUETA:area_definida]]\nUno [[NUEVO_MENSAJE]] Dos')
    expect(out.messages).toEqual(['Listo ✅\nUno', 'Dos'])
    expect(out.actions).toEqual([{ type: 'label', value: 'area_definida' }])
  })

  it('never shows unknown or unterminated control lines', () => {
    const out = parseBotOutput('Hola\n[[ALGO_NUEVO|x=1]]\n[[ROTO sin cerrar\nChao')
    expect(out.messages).toEqual(['Hola\nChao'])
    expect(out.actions).toEqual([])
  })

  it('drops empty parts and caps the number of messages', () => {
    const many = Array.from({ length: MAX_MESSAGES_PER_TURN + 2 }, (_, i) => `m${i}`).join(
      '\n[[NUEVO_MENSAJE]]\n',
    )
    const out = parseBotOutput(`[[NUEVO_MENSAJE]]\n\n${many}\n[[NUEVO_MENSAJE]]`)
    expect(out.messages).toHaveLength(MAX_MESSAGES_PER_TURN)
    expect(out.messages[0]).toBe('m0')
    // Overflow is folded into the last message, not lost.
    expect(out.messages[MAX_MESSAGES_PER_TURN - 1]).toContain(`m${MAX_MESSAGES_PER_TURN + 1}`)
  })
})
