// Rumbo a la U — local change (see RUMBO.md): the Cloud API `voice: true` flag on audio.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendMediaMessage } from '@/lib/whatsapp/meta-api'

describe('voice notes', () => {
  afterEach(() => vi.unstubAllGlobals())

  const sentBody = async (args: Partial<Parameters<typeof sendMediaMessage>[0]>) => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await sendMediaMessage({ phoneNumberId: 'p', accessToken: 't', to: '584121234567', kind: 'audio', link: 'https://x/a.ogg', ...args })
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    return JSON.parse(String(init.body))
  }

  it('audio with voice → audio.voice = true (native green voice note)', async () => {
    expect((await sentBody({ voice: true })).audio).toEqual({ link: 'https://x/a.ogg', voice: true })
  })

  it('audio without voice and other kinds: unchanged (upstream behavior)', async () => {
    expect((await sentBody({})).audio).toEqual({ link: 'https://x/a.ogg' })
    expect((await sentBody({ kind: 'image', voice: true, link: 'https://x/i.jpg' })).image).toEqual({ link: 'https://x/i.jpg' })
  })
})
