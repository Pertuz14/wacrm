// Rumbo a la U — local change (see RUMBO.md, cambio 9).
// Revisa el texto del bot que se sube desde un archivo: que sea el de ese canal y que no esté incompleto.
// WhatsApp = crm/Comportamiento AI/PEGAR_EN_CONTEXTO_DEL_NEGOCIO.txt (lleva <base_conocimiento>);
// Instagram = solo la nota de la IA (sección 1 de 04_instagram.md), sin la base.

export type BotChannel = 'whatsapp' | 'instagram'

const LIMITS: Record<BotChannel, { min: number; max: number }> = {
  whatsapp: { min: 20_000, max: 400_000 },
  instagram: { min: 100, max: 8_000 },
}

/** Quita la marca BOM y los saltos de línea de Windows; recorta los espacios de los extremos. */
export function normalizeBotText(raw: string): string {
  return raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
}

/** null si el texto sirve para ese canal; si no, el aviso para mostrar. */
export function checkBotText(channel: BotChannel, text: string): string | null {
  const length = [...text].length
  const hasBase = text.includes('<base_conocimiento>') && text.includes('</base_conocimiento>')
  if (!length) return 'El archivo está vacío.'
  if (channel === 'whatsapp' && !hasBase) {
    return 'Ese no parece el archivo del bot de WhatsApp: suba PEGAR_EN_CONTEXTO_DEL_NEGOCIO.txt (el que arma armar_pegar.mjs).'
  }
  if (channel === 'instagram' && hasBase) {
    return 'Ese es el archivo de WhatsApp. Aquí va solo la nota de la IA de Instagram (sección 1 de 04_instagram.md).'
  }
  const { min, max } = LIMITS[channel]
  if (length < min) return `El texto es muy corto (${length.toLocaleString('es-VE')} caracteres): parece incompleto.`
  if (length > max) return `El texto es muy largo (${length.toLocaleString('es-VE')} caracteres; máximo ${max.toLocaleString('es-VE')}).`
  return null
}
