import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => ({ body: { error: 'forbidden' }, status: 403 }),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => ({ body: { error: 'rate' }, status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}))

type Reply = { body: { models?: { id: string; name: string }[]; error?: string }; status: number }

const CATALOGUE = {
  data: [
    { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o mini' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
  ],
}

function okResponse(payload: unknown) {
  return { ok: true, json: async () => payload }
}

// The route keeps a module-level cache, so every test imports a fresh copy.
async function loadGet() {
  vi.resetModules()
  const mod = await import('./route')
  return mod.GET as () => Promise<Reply>
}

describe('GET /api/ai/openrouter-models', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    h.requireRole.mockReset()
    h.requireRole.mockResolvedValue({ userId: 'user-1' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns the catalogue sorted by name and asks only for admins', async () => {
    fetchMock.mockResolvedValue(okResponse(CATALOGUE))
    const GET = await loadGet()

    const res = await GET()

    expect(h.requireRole).toHaveBeenCalledWith('admin')
    expect(res.status).toBe(200)
    // "Anthropic: …" sorts before "OpenAI: …" even though the feed lists OpenAI first.
    expect(res.body.models?.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o-mini',
    ])
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/models')
  })

  it('never sends credentials to OpenRouter', async () => {
    fetchMock.mockResolvedValue(okResponse(CATALOGUE))
    const GET = await loadGet()

    await GET()

    const init = fetchMock.mock.calls[0][1] as { headers?: Record<string, string> }
    expect(Object.keys(init.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      'authorization',
    )
  })

  it('serves repeated calls from the cache', async () => {
    fetchMock.mockResolvedValue(okResponse(CATALOGUE))
    const GET = await loadGet()

    await GET()
    await GET()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers 502 when OpenRouter is unreachable and nothing is cached', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const GET = await loadGet()

    const res = await GET()

    expect(res.status).toBe(502)
    expect(res.body.error).toBeTruthy()
  })

  it('answers 502 when OpenRouter returns an empty or invalid catalogue', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [] }))
    const GET = await loadGet()

    expect((await GET()).status).toBe(502)
  })

  it('serves the stale copy when a refresh fails after the cache expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'))
    fetchMock.mockResolvedValueOnce(okResponse(CATALOGUE))
    const GET = await loadGet()
    await GET()

    vi.setSystemTime(new Date('2026-10-08T03:00:00Z')) // well past the 1h TTL
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const res = await GET()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    expect(res.body.models).toHaveLength(2)
  })

  it('rejects callers who are not admins', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    const GET = await loadGet()

    const res = await GET()

    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
