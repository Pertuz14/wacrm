import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildEvent, capiConfig, normalizePhone, sendEvent, sha256, type CapiConfig } from './capi'
import { pickTouch } from './capi-queue'

const cfg: CapiConfig = {
  active: true,
  token: 'tok',
  apiVersion: 'v27.0',
  datasets: { whatsapp: '111', instagram: '222', website: '333' },
  pageId: '999',
  testCode: 'TEST123',
  flushSecret: 's',
}
const at = new Date('2026-11-14T15:00:00Z')

describe('capi payloads', () => {
  it('Click-to-WhatsApp purchase carries the WABA, the click id and the value', () => {
    const e = buildEvent(
      {
        eventId: 'ev1',
        step: 'purchase',
        occurredAt: at,
        identity: { channel: 'whatsapp', wabaId: 'waba', ctwaClid: 'clid' },
        valueUsd: 55,
        program: 'simadi',
      },
      cfg,
    )
    expect(e).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(at.getTime() / 1000),
      event_id: 'ev1',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: 'waba', ctwa_clid: 'clid', page_id: '999' },
      custom_data: { currency: 'USD', value: 55, content_category: 'simadi' },
    })
  })

  it('Instagram lead uses the Instagram ids and LeadSubmitted', () => {
    const e = buildEvent(
      { eventId: 'ev2', step: 'lead', occurredAt: at, identity: { channel: 'instagram', igAccountId: 'ig', igsid: 'sid' } },
      cfg,
    )
    expect(e.event_name).toBe('LeadSubmitted')
    expect(e.messaging_channel).toBe('instagram')
    expect(e.user_data).toEqual({ instagram_business_account_id: 'ig', ig_sid: 'sid' })
    expect(e.custom_data).toBeUndefined()
  })

  it('web-ad customers go to the pixel as chat events, hashed, with the visit code as external_id', () => {
    const e = buildEvent(
      {
        eventId: 'ev3',
        step: 'lead',
        occurredAt: at,
        identity: { channel: 'website', visitCode: 'k7m2qx4abc', phone: '+58 412-123 4567', email: ' Ana@Mail.com ' },
      },
      cfg,
    )
    expect(e.event_name).toBe('Lead')
    expect(e.action_source).toBe('chat')
    expect(e.user_data).toEqual({
      external_id: [sha256('k7m2qx4abc')],
      ph: [sha256('584121234567')],
      em: [sha256('ana@mail.com')],
      country: [sha256('ve')],
    })
  })

  it('normalizes Venezuelan phones', () => {
    expect(normalizePhone('+58 412 123 4567')).toBe('584121234567')
    expect(normalizePhone('04121234567')).toBe('584121234567')
    expect(normalizePhone('0058 4121234567')).toBe('584121234567')
    expect(normalizePhone('123')).toBeNull()
  })
})

describe('which ad arrival identifies the contact', () => {
  const touch = (id: string, channel: string, created: string, extra: Record<string, unknown> = {}) => ({
    id,
    channel,
    source: 'anuncio_meta',
    click_id: null,
    ad_id: null,
    visit_code: null,
    created_at: created,
    ...extra,
  })

  it('prefers a WhatsApp click id, then Instagram, then the website visit code', () => {
    const t = [
      touch('web', 'whatsapp', '2026-11-14T10:00:00Z', { visit_code: 'abcdefgh' }),
      touch('wa', 'whatsapp', '2026-11-13T10:00:00Z', { click_id: 'clid' }),
      touch('ig', 'instagram', '2026-11-12T10:00:00Z', { source: 'anuncio_instagram' }),
    ]
    expect(pickTouch(t, at)?.id).toBe('wa')
    expect(pickTouch(t.slice(2).concat(t[0]), at)?.id).toBe('ig')
    expect(pickTouch([t[0]], at)?.id).toBe('web')
  })

  it('ignores arrivals after the event and non-ad sources', () => {
    expect(pickTouch([touch('later', 'whatsapp', '2026-11-20T10:00:00Z', { click_id: 'c' })], at)).toBeNull()
    expect(pickTouch([touch('web', 'whatsapp', '2026-11-13T10:00:00Z', { source: 'web', visit_code: 'abcd' })], at)).toBeNull()
  })
})

describe('sending', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('posts to the dataset with the test code and reads events_received', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') })
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await sendEvent(cfg, 'whatsapp', { event_name: 'Purchase' }, { test: true, fetcher })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe('https://graph.facebook.com/v27.0/111/events')
    expect(calls[0].body).toEqual({ data: [{ event_name: 'Purchase' }], test_event_code: 'TEST123' })
    expect(calls[0].auth).toBe('Bearer tok')
  })

  it("returns Meta's error message and never throws", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid parameter' } }), { status: 400 })) as unknown as typeof fetch
    expect(await sendEvent(cfg, 'website', {}, { fetcher })).toEqual({ ok: false, detail: 'Invalid parameter' })
    const broken = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await sendEvent(cfg, 'website', {}, { fetcher: broken })).toEqual({ ok: false, detail: 'offline' })
    expect((await sendEvent({ ...cfg, token: null }, 'website', {})).ok).toBe(false)
  })

  it('is off unless META_CAPI_ACTIVO is exactly true; one shared dataset fills every channel', () => {
    vi.stubEnv('META_CAPI_ACTIVO', 'yes')
    vi.stubEnv('META_CAPI_DATASET', '777')
    const c = capiConfig()
    expect(c.active).toBe(false)
    expect(c.datasets).toEqual({ whatsapp: '777', instagram: '777', website: '777' })
  })
})
