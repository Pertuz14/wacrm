// ============================================================
// Rumbo (RUMBO.md, cambio 7): WhatsApp's text formatting in the inbox.
//
// WhatsApp shows *bold*, _italic_ and ~strikethrough~; the inbox printed
// the raw markers («*Resumen de su compra*»), so the bot's messages looked
// broken in the CRM while they looked fine on the customer's phone.
// Same rules as WhatsApp: a marker opens before a non-space character and
// closes after one, inside a single line, next to a space, punctuation or
// the edge of the text. Links are never formatted (a payment link may
// contain «_» or «~»).
// ============================================================

import { Fragment, type ReactNode } from 'react'

export interface Pieza {
  texto: string
  negrita?: boolean
  cursiva?: boolean
  tachado?: boolean
}

type Estilo = Omit<Pieza, 'texto'>

const ENLACE = /https?:\/\/\S+|www\.\S+/gi
// (antes) (marca) (contenido sin saltos de línea, que no empieza ni termina con espacio) (la misma marca) (después)
const FORMATO = /(^|[\s([{¿¡"'«])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s)\]}.,;:!?"'»])/g

const ESTILO_DE: Record<string, Estilo> = { '*': { negrita: true }, _: { cursiva: true }, '~': { tachado: true } }

function formatear(texto: string, estilo: Estilo): Pieza[] {
  const piezas: Pieza[] = []
  let desde = 0
  for (const m of texto.matchAll(FORMATO)) {
    const inicio = (m.index ?? 0) + m[1].length
    piezas.push({ texto: texto.slice(desde, inicio), ...estilo })
    piezas.push(...formatear(m[3], { ...estilo, ...ESTILO_DE[m[2]] }))
    desde = (m.index ?? 0) + m[0].length
  }
  piezas.push({ texto: texto.slice(desde), ...estilo })
  return piezas
}

/** The text split into pieces with their style (pure, for the tests). */
export function piezasWhatsApp(texto: string): Pieza[] {
  const piezas: Pieza[] = []
  let desde = 0
  for (const m of texto.matchAll(ENLACE)) {
    piezas.push(...formatear(texto.slice(desde, m.index), {}))
    piezas.push({ texto: m[0] })
    desde = (m.index ?? 0) + m[0].length
  }
  piezas.push(...formatear(texto.slice(desde), {}))
  return piezas.filter((p) => p.texto)
}

/**
 * The text as React nodes (plain strings and <strong>/<em>/<s> with string
 * children), so <Linkify> can still find the links inside them.
 */
export function nodosWhatsApp(texto: string): ReactNode[] {
  return piezasWhatsApp(texto).map((p, i) => {
    let nodo: ReactNode = p.texto
    if (p.tachado) nodo = <s>{nodo}</s>
    if (p.cursiva) nodo = <em>{nodo}</em>
    if (p.negrita) nodo = <strong className="font-semibold">{nodo}</strong>
    return <Fragment key={i}>{nodo}</Fragment>
  })
}
