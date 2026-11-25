// Rumbo a la U — local change (RUMBO.md, cambios 15 y 16).
import { describe, expect, it } from 'vitest'
import { pierdeElEmpate } from './mensajes-juntos'
import { yaRecibioElDm } from './comentario-dm'

describe('Rumbo: dos mensajes en el mismo segundo', () => {
  // Moraima (23-nov): dos mensajes con el mismo created_at
  const A = '1af5f9cc-2e71-49f7-b296-be6741e03615'
  const B = 'a505c01a-f7ce-43df-a369-24da7f2041b1'

  it('responde uno solo: el de id mayor', () => {
    expect(pierdeElEmpate(A, [A, B])).toBe(true)
    expect(pierdeElEmpate(B, [A, B])).toBe(false)
  })

  it('un mensaje solo siempre responde', () => {
    expect(pierdeElEmpate(A, [A])).toBe(false)
    expect(pierdeElEmpate(A, [])).toBe(false)
  })
})

describe('Rumbo: mensaje automático por comentario, una vez por persona', () => {
  const primero = { id: 'b1', comment_id: 'c1', created_at: '2026-11-24T19:40:24.116Z' }
  const segundo = { id: 'a2', comment_id: 'c2', created_at: '2026-11-24T19:46:55.951Z' }

  it('el segundo comentario (otra publicación) ya no manda el mensaje', () => {
    expect(yaRecibioElDm(segundo, [primero, segundo])).toBe(true)
  })

  it('el primer comentario sí lo manda', () => {
    expect(yaRecibioElDm(primero, [primero, segundo])).toBe(false)
    expect(yaRecibioElDm(primero, [primero])).toBe(false)
  })

  it('dos comentarios en el mismo instante: sale uno solo', () => {
    const x = { id: 'aaa', comment_id: 'c3', created_at: '2026-11-24T20:00:00.000Z' }
    const y = { id: 'bbb', comment_id: 'c4', created_at: '2026-11-24T20:00:00.000Z' }
    expect(yaRecibioElDm(x, [x, y])).toBe(false)
    expect(yaRecibioElDm(y, [x, y])).toBe(true)
  })
})
