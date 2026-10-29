import { describe, it, expect } from 'vitest'
import {
  classifyInbound,
  classifyMessageMarker,
  classifyWhatsAppReferral,
  originNote,
  recordLeadSource,
} from './source'
import { furthest, stageKinds } from './report'

describe('classifyWhatsAppReferral', () => {
  it('tells Instagram ads from Facebook ads and keeps the ad id and click id', () => {
    expect(
      classifyWhatsAppReferral({
        source_type: 'ad',
        source_id: '120200001',
        source_url: 'https://www.instagram.com/p/abc/',
        headline: 'Prepárate para el SIMADI',
        ctwa_clid: 'clid-1',
      }),
    ).toEqual({
      source: 'anuncio_instagram',
      detail: 'Prepárate para el SIMADI',
      adId: '120200001',
      sourceUrl: 'https://www.instagram.com/p/abc/',
      clickId: 'clid-1',
    })
    expect(classifyWhatsAppReferral({ source_type: 'ad', source_url: 'https://fb.me/xyz', body: 'Guía' })?.source).toBe(
      'anuncio_facebook',
    )
    expect(classifyWhatsAppReferral({ source_type: 'ad', source_id: '9' })?.source).toBe('anuncio_meta')
    expect(classifyWhatsAppReferral({ source_type: 'post', source_url: 'https://fb.com/p' })?.source).toBe('publicacion')
    expect(classifyWhatsAppReferral(undefined)).toBeNull()
  })
})

describe('classifyMessageMarker', () => {
  it('reads "(vi la web)" and keeps what the person asked for', () => {
    expect(classifyMessageMarker('Hola, quiero el paquete completo (vi la web)')).toMatchObject({
      source: 'web',
      detail: 'Hola, quiero el paquete completo',
    })
  })

  it('reads TikTok, Instagram and unknown "(vi X)" markers', () => {
    expect(classifyMessageMarker('Hola, quiero información (vi TikTok)')?.source).toBe('tiktok')
    expect(classifyMessageMarker('Hola (vi en Instagram).')?.source).toBe('instagram')
    expect(classifyMessageMarker('Hola (vi un volante)')).toMatchObject({ source: 'otro', detail: 'un volante' })
    expect(classifyMessageMarker('Los vi en tiktok y quiero info')?.source).toBe('tiktok')
  })

  it('ignores normal messages', () => {
    expect(classifyMessageMarker('Hola, quiero información')).toBeNull()
    expect(classifyMessageMarker('')).toBeNull()
  })
})

describe('classifyInbound', () => {
  const base = { channel: 'whatsapp' as const, isFirstInbound: true, text: 'Hola' }

  it('counts a plain first message as direct WhatsApp, and later ones as nothing', () => {
    expect(classifyInbound(base)?.source).toBe('whatsapp')
    expect(classifyInbound({ ...base, isFirstInbound: false })).toBeNull()
  })

  it('records an ad click even on a later message', () => {
    expect(
      classifyInbound({ ...base, isFirstInbound: false, waReferral: { source_type: 'ad', source_id: '1' } })?.source,
    ).toBe('anuncio_meta')
  })

  it('Instagram: ad, comment-to-DM, or plain DM', () => {
    const ig = { channel: 'instagram' as const, isFirstInbound: true, text: 'Hola' }
    expect(classifyInbound({ ...ig, igReferral: { ad_id: '5', ads_context_data: { ad_title: 'Guía' } } })).toMatchObject({
      source: 'anuncio_instagram',
      adId: '5',
      detail: 'Guía',
    })
    expect(classifyInbound({ ...ig, commentKeyword: 'GUIA' })).toMatchObject({ source: 'comentario_instagram', detail: 'GUIA' })
    expect(classifyInbound(ig)?.source).toBe('instagram')
  })

  it('writes a readable contact note', () => {
    expect(
      originNote({ source: 'anuncio_instagram', detail: 'Guía SIMADI', adId: '77', sourceUrl: null, clickId: null }),
    ).toBe('📍 Origen: Anuncio de Instagram «Guía SIMADI» (ID del anuncio 77)')
  })
})

describe('recordLeadSource', () => {
  function fakeDb(prior: unknown[]) {
    const inserts: { table: string; row: Record<string, unknown> }[] = []
    const from = (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order']) q[m] = () => q
      q.limit = async () => ({ data: prior, error: null })
      q.insert = async (row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return { error: null }
      }
      return q
    }
    return { db: { from } as unknown as Parameters<typeof recordLeadSource>[0], inserts }
  }
  const args = {
    accountId: 'a',
    contactId: 'c',
    conversationId: 'v',
    userId: 'u',
    channel: 'whatsapp' as const,
    isFirstInbound: true,
    text: 'Quiero la guía (vi la web)',
  }

  it('stores the first touch and a contact note', async () => {
    const { db, inserts } = fakeDb([])
    await recordLeadSource(db, args)
    expect(inserts[0]).toMatchObject({ table: 'lead_sources', row: { source: 'web', is_first_touch: true } })
    expect(inserts[1]).toMatchObject({ table: 'contact_notes' })
  })

  it('skips the same origin repeated within hours', async () => {
    const { db, inserts } = fakeDb([{ source: 'web', detail: 'x', ad_id: null, created_at: new Date().toISOString() }])
    await recordLeadSource(db, args)
    expect(inserts).toHaveLength(0)
  })

  it('keeps a new origin of a known contact as a later touch', async () => {
    const { db, inserts } = fakeDb([{ source: 'whatsapp', detail: null, ad_id: null, created_at: '2026-01-01T00:00:00Z' }])
    await recordLeadSource(db, { ...args, isFirstInbound: false })
    expect(inserts[0]).toMatchObject({ row: { source: 'web', is_first_touch: false } })
  })
})

describe('report helpers', () => {
  const kinds = stageKinds(
    { pipelineId: 'p', stageNewId: 'n', stageInterestedId: 'i', stageVerifyId: 'v', stageLostId: 'l', stageWonId: null },
    'w',
  )
  it('takes the furthest stage a deal went through, ignoring lost', () => {
    expect(furthest(['n', 'i', 'v', 'l'], kinds)).toBe('verificar')
    expect(furthest(['n', 'w'], kinds)).toBe('venta')
    expect(furthest(['l', 'other'], kinds)).toBeNull()
  })
})
