import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapiConfig } from './capi'

vi.mock('@/lib/ai/pipeline-sync', () => ({
  loadPipelineSync: async () => ({ pipelineId: 'p-simadi' }),
  loadProgramPipelines: async () => [
    { program: 'simadi', pipelineId: 'p-simadi', stageNewId: 's-new', stageInterestedId: 's-int', stageVerifyId: 's-ver', stageLostId: 's-lost', stageWonId: 's-won' },
    { program: 'colegio', pipelineId: 'p-col', stageNewId: 'c-new', stageInterestedId: 'c-int', stageVerifyId: 'c-ver', stageLostId: 'c-lost', stageWonId: 'c-won' },
  ],
  resolveWonStage: async (_db: unknown, p: { stageWonId: string }) => p.stageWonId,
}))

const { flushCapiQueue } = await import('./capi-queue')

type Row = Record<string, unknown>

/** In-memory Supabase: just the query shapes the queue uses. */
function memoryDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let patch: Row | null = null
    let limit = Infinity
    let order: { col: string; asc: boolean } | null = null
    const rows = () => {
      let out = (tables[table] ??= []).filter((r) => filters.every((f) => f(r)))
      if (order) {
        const { col, asc } = order
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
      }
      return out.slice(0, limit)
    }
    const run = () => {
      const hit = rows()
      if (patch) for (const r of hit) Object.assign(r, patch)
      return { data: hit, error: null, count: hit.length }
    }
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      lt: (c: string, v: string | number) => (filters.push((r) => (r[c] as string | number) < v), q),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      update: (p: Row) => ((patch = p), q),
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => ok(run()),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

const cfg: CapiConfig = {
  tokens: { whatsapp: 'tok', instagram: 'tok', website: 'tok' },
  active: true,
  token: 'tok',
  apiVersion: 'v27.0',
  datasets: { whatsapp: 'ds-wa', instagram: 'ds-ig', website: 'px' },
  pageId: null,
  testCode: null,
  flushSecret: 's',
}
const now = new Date('2026-11-14T15:00:00Z')

function queue(extra: Row): Row {
  return {
    id: 'q',
    account_id: 'acc',
    contact_id: 'c1',
    deal_id: 'd1',
    stage_event_id: null,
    lead_source_id: null,
    pipeline_id: 'p-simadi',
    stage_id: null,
    occurred_at: '2026-11-14T12:00:00Z',
    status: 'pending',
    attempts: 0,
    test_mode: false,
    ...extra,
  }
}

let sent: { url: string; body: { data: Row[] } }[]
const fetcher = (async (url: string, init: RequestInit) => {
  sent.push({ url, body: JSON.parse(String(init.body)) })
  return new Response(JSON.stringify({ events_received: 1 }), { status: 200 })
}) as unknown as typeof fetch

function baseTables(): Record<string, Row[]> {
  return {
    whatsapp_config: [{ account_id: 'acc', waba_id: 'waba-1' }],
    instagram_config: [{ account_id: 'acc', ig_account_id: 'ig-1' }],
    contacts: [{ id: 'c1', phone: '+584121234567', email: null, ig_user_id: 'igsid-1' }],
    deals: [{ id: 'd1', value: 55, currency: 'USD' }],
    lead_sources: [
      {
        id: 'ls1',
        contact_id: 'c1',
        channel: 'whatsapp',
        source: 'anuncio_instagram',
        click_id: 'clid-1',
        ad_id: 'ad',
        visit_code: null,
        created_at: '2026-11-14T10:00:00Z',
      },
    ],
    capi_events: [],
  }
}

beforeEach(() => {
  sent = []
})

describe('flushCapiQueue', () => {
  it('turns stages of an ad contact into QualifiedLead, InitiateCheckout and Purchase, once each', async () => {
    const t = baseTables()
    t.capi_events.push(
      queue({ id: 'q-lead', lead_source_id: 'ls1', deal_id: null, occurred_at: '2026-11-14T10:00:00Z' }),
      queue({ id: 'q-new', stage_id: 's-new', occurred_at: '2026-11-14T10:01:00Z' }),
      queue({ id: 'q-int', stage_id: 's-int', occurred_at: '2026-11-14T11:00:00Z' }),
      queue({ id: 'q-ver', stage_id: 's-ver', occurred_at: '2026-11-14T11:30:00Z' }),
      queue({ id: 'q-won', stage_id: 's-won', occurred_at: '2026-11-14T12:00:00Z' }),
      queue({ id: 'q-int2', stage_id: 's-int', occurred_at: '2026-11-14T12:30:00Z' }),
    )
    const s = await flushCapiQueue(memoryDb(t), cfg, { now, fetcher })
    expect(s).toMatchObject({ sent: 4, skipped: 2, failed: 0 })
    expect(sent.map((x) => x.body.data[0].event_name)).toEqual(['LeadSubmitted', 'QualifiedLead', 'InitiateCheckout', 'Purchase'])
    const purchase = sent[3].body.data[0]
    expect(sent[3].url).toBe('https://graph.facebook.com/v27.0/ds-wa/events')
    expect(purchase.user_data).toEqual({ whatsapp_business_account_id: 'waba-1', ctwa_clid: 'clid-1' })
    expect(purchase.custom_data).toEqual({ currency: 'USD', value: 55, content_category: 'simadi' })
    expect(purchase.event_id).toBe('q-won')
    const byId = Object.fromEntries(t.capi_events.map((r) => [r.id, r]))
    expect(byId['q-new']).toMatchObject({ status: 'skipped', reason: 'Etapa sin evento para Meta' })
    expect(byId['q-int2']).toMatchObject({ status: 'skipped', reason: 'Ya enviado para esta tarjeta' })
    expect(byId['q-won']).toMatchObject({ status: 'sent', channel: 'whatsapp', event_name: 'Purchase', attempts: 1 })

    // A second run sends nothing again
    sent = []
    await flushCapiQueue(memoryDb(t), cfg, { now, fetcher })
    expect(sent).toHaveLength(0)
  })

  it('skips contacts that did not come from an ad, and the schools pipeline', async () => {
    const t = baseTables()
    t.lead_sources = [
      { id: 'ls0', contact_id: 'c1', channel: 'whatsapp', source: 'web', click_id: null, created_at: '2026-11-14T10:00:00Z' },
    ]
    t.capi_events.push(queue({ id: 'q1', stage_id: 's-int' }), queue({ id: 'q2', stage_id: 'c-int' }))
    const s = await flushCapiQueue(memoryDb(t), cfg, { now, fetcher })
    expect(s.skipped).toBe(2)
    expect(sent).toHaveLength(0)
    expect(t.capi_events.map((r) => r.reason)).toEqual(['No llegó por un anuncio', 'Etapa sin evento para Meta'])
  })

  it('a purchase without a USD value waits; switched off nothing leaves; old rows expire', async () => {
    const t = baseTables()
    t.deals = [{ id: 'd1', value: null, currency: 'USD' }]
    t.capi_events.push(
      queue({ id: 'q-won', stage_id: 's-won' }),
      queue({ id: 'q-old', stage_id: 's-int', occurred_at: '2026-11-01T10:00:00Z' }),
    )
    const s = await flushCapiQueue(memoryDb(t), { ...cfg, active: false }, { now, fetcher })
    expect(s).toMatchObject({ expired: 1, sent: 0 })
    expect(t.capi_events[0].status).toBe('pending')

    const s2 = await flushCapiQueue(memoryDb(t), cfg, { now, fetcher })
    expect(s2.waiting).toBe(1)
    expect(t.capi_events[0]).toMatchObject({ status: 'pending', reason: 'La compra no tiene monto en USD en la tarjeta' })
    expect(sent).toHaveLength(0)
  })

  it('web-ad contacts go to the pixel with the visit code; Instagram ads use the Instagram ids', async () => {
    const t = baseTables()
    t.lead_sources = [
      {
        id: 'w',
        contact_id: 'c1',
        channel: 'whatsapp',
        source: 'anuncio_meta',
        click_id: null,
        visit_code: 'abcdefgh23',
        created_at: '2026-11-14T10:00:00Z',
      },
    ]
    t.capi_events.push(queue({ id: 'q1', stage_id: 's-ver' }))
    await flushCapiQueue(memoryDb(t), cfg, { now, fetcher })
    expect(sent[0].url).toContain('/px/events')
    expect(sent[0].body.data[0]).toMatchObject({ event_name: 'InitiateCheckout', action_source: 'chat' })

    const t2 = baseTables()
    t2.lead_sources = [
      { id: 'i', contact_id: 'c1', channel: 'instagram', source: 'anuncio_instagram', click_id: null, created_at: '2026-11-14T10:00:00Z' },
    ]
    t2.capi_events.push(queue({ id: 'q2', lead_source_id: 'i', deal_id: null }))
    sent = []
    await flushCapiQueue(memoryDb(t2), cfg, { now, fetcher })
    expect(sent[0].body.data[0]).toMatchObject({
      event_name: 'LeadSubmitted',
      messaging_channel: 'instagram',
      user_data: { instagram_business_account_id: 'ig-1', ig_sid: 'igsid-1' },
    })
  })

  it('keeps the error from Meta and retries on the next run', async () => {
    const t = baseTables()
    t.capi_events.push(queue({ id: 'q1', stage_id: 's-int' }))
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid ctwa_clid' } }), { status: 400 })) as unknown as typeof fetch
    const s = await flushCapiQueue(memoryDb(t), cfg, { now, fetcher: failing })
    expect(s.failed).toBe(1)
    expect(t.capi_events[0]).toMatchObject({ status: 'error', reason: 'Invalid ctwa_clid', attempts: 1 })
    await flushCapiQueue(memoryDb(t), cfg, { now, fetcher })
    expect(t.capi_events[0]).toMatchObject({ status: 'sent', attempts: 2 })
  })
})
