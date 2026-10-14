import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}))
vi.mock('web-push', () => ({
  default: { sendNotification: h.sendNotification, setVapidDetails: h.setVapidDetails },
}))

function fakeDb(rows: unknown[]) {
  const deleted: string[][] = []
  const updated: string[][] = []
  const db = {
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }),
      delete: () => ({ in: (_c: string, ids: string[]) => { deleted.push(ids); return Promise.resolve({ error: null }) } }),
      update: () => ({ in: (_c: string, ids: string[]) => { updated.push(ids); return Promise.resolve({ error: null }) } }),
    }),
  }
  return { db: db as never, deleted, updated }
}

const SUBS = [
  { id: 's1', endpoint: 'https://push.example/1', p256dh: 'k1', auth: 'a1' },
  { id: 's2', endpoint: 'https://push.example/2', p256dh: 'k2', auth: 'a2' },
]

beforeEach(() => {
  vi.resetModules()
  h.sendNotification.mockReset()
  h.setVapidDetails.mockReset()
  process.env.VAPID_PUBLIC_KEY = 'pub'
  process.env.VAPID_PRIVATE_KEY = 'priv'
  process.env.VAPID_SUBJECT = 'mailto:test@example.com'
})

describe('web push', () => {
  it('is a no-op without VAPID keys', async () => {
    delete process.env.VAPID_PRIVATE_KEY
    const { sendPushToAccount } = await import('./web-push')
    const { db } = fakeDb(SUBS)
    expect(await sendPushToAccount(db, 'acct', { title: 't', body: 'b', url: '/inbox', tag: 'x' })).toBe(0)
    expect(h.sendNotification).not.toHaveBeenCalled()
  })

  it('sends to every device of the account and prunes dead ones', async () => {
    h.sendNotification.mockImplementation((sub: { endpoint: string }) =>
      sub.endpoint.endsWith('/2') ? Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 })) : Promise.resolve({}),
    )
    const { sendPushToAccount } = await import('./web-push')
    const { db, deleted, updated } = fakeDb(SUBS)
    const sent = await sendPushToAccount(db, 'acct', { title: 'Ana', body: 'hola', url: '/inbox?c=c1', tag: 'c1' })
    expect(sent).toBe(1)
    expect(h.sendNotification).toHaveBeenCalledTimes(2)
    expect(JSON.parse(h.sendNotification.mock.calls[0][1])).toMatchObject({ title: 'Ana', url: '/inbox?c=c1' })
    expect(deleted).toEqual([['s2']])
    expect(updated).toEqual([['s1']])
  })

  it('builds the alert from the inbound message', async () => {
    h.sendNotification.mockResolvedValue({})
    const { notifyInboundMessage } = await import('./web-push')
    const { db } = fakeDb([SUBS[0]])
    await notifyInboundMessage(db, {
      accountId: 'acct',
      conversationId: 'conv-1',
      messageId: 'm1',
      contactName: 'Giselle',
      contentType: 'text',
      contentText: 'info',
    })
    const payload = JSON.parse(h.sendNotification.mock.calls[0][1])
    expect(payload).toMatchObject({ title: 'Giselle', body: 'info', tag: 'conv-1' })
    expect(payload.url).toContain('conv-1')
  })
})
