// Rumbo a la U — local change (see RUMBO.md, cambio 9).
import { describe, expect, it } from 'vitest'
import { checkBotText, normalizeBotText } from './bot-text'

const pegar = `Eres el asistente.\n${'Regla. '.repeat(4000)}\n<base_conocimiento>\nM07\n</base_conocimiento>`
const nota = 'Nota de la IA para Instagram. '.repeat(10)

describe('texto del bot subido desde un archivo', () => {
  it('acepta cada archivo en su canal', () => {
    expect(checkBotText('whatsapp', pegar)).toBeNull()
    expect(checkBotText('instagram', nota)).toBeNull()
  })
  it('avisa si el archivo es del otro canal, está vacío o incompleto', () => {
    expect(checkBotText('whatsapp', nota)).toMatch(/PEGAR_EN_CONTEXTO/)
    expect(checkBotText('instagram', pegar)).toMatch(/archivo de WhatsApp/)
    expect(checkBotText('whatsapp', '')).toMatch(/vacío/)
    expect(checkBotText('whatsapp', '<base_conocimiento></base_conocimiento>')).toMatch(/corto/)
    expect(checkBotText('instagram', 'x'.repeat(9000))).toMatch(/largo/)
  })
  it('limpia la marca BOM y los saltos de Windows', () => {
    expect(normalizeBotText('﻿hola\r\nmundo\r\n')).toBe('hola\nmundo')
  })
})
