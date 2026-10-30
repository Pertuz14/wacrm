import { afterEach, describe, expect, it, vi } from 'vitest'

// No DNS lookups in tests: every endpoint counts as deliverable.
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }))

import { buildSystemPrompt } from '../defaults'
import {
  generateOpenAiCompatible,
  REPLY_TEMPERATURE,
  systemMessageFor,
  wantsPromptCache,
} from './openai-compatible'

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions'

function ok(text = 'Hola') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20000, completion_tokens: 30, total_tokens: 20030, prompt_tokens_details: { cached_tokens: 19500 } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** Text the model would read from a system message, whatever its shape. */
function systemText(body: { messages: { role: string; content: unknown }[] }): string {
  const content = body.messages[0].content
  return typeof content === 'string' ? content : (content as { text: string }[]).map((p) => p.text).join('')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wantsPromptCache', () => {
  it('only for Claude models through OpenRouter', () => {
    expect(wantsPromptCache(OPENROUTER, 'anthropic/claude-haiku-5.5')).toBe(true)
    expect(wantsPromptCache(OPENROUTER, 'google/gemini-3-flash')).toBe(false)
    expect(wantsPromptCache('https://api.groq.com/openai/v1/chat/completions', 'anthropic/x')).toBe(false)
    expect(wantsPromptCache('https://evil-openrouter.ai.example.com/v1', 'anthropic/x')).toBe(false)
    expect(wantsPromptCache('not a url', 'anthropic/x')).toBe(false)
  })
})

describe('systemMessageFor', () => {
  const withKnowledge = buildSystemPrompt({
    userPrompt: 'Eres el asistente de Rumbo a la U. Hoy es 30/10/2026.',
    mode: 'auto_reply',
    knowledge: ['El paquete incluye guía, banco y simulacros.'],
  })
  const withoutKnowledge = buildSystemPrompt({ userPrompt: 'Instrucciones del negocio', mode: 'auto_reply' })

  it('keeps the exact text the model reads, with or without knowledge', () => {
    for (const prompt of [withKnowledge, withoutKnowledge, withoutKnowledge + '\n\nNota de Instagram']) {
      const msg = systemMessageFor(prompt, true)
      const text = typeof msg.content === 'string' ? msg.content : msg.content.map((p) => p.text).join('')
      expect(text).toBe(prompt)
    }
  })

  it('caches the stable instructions and leaves the per-question knowledge out', () => {
    const msg = systemMessageFor(withKnowledge, true)
    if (typeof msg.content === 'string') throw new Error('expected parts')
    expect(msg.content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(msg.content[0].text).toContain('Eres el asistente de Rumbo a la U')
    expect(msg.content[0].text).not.toContain('Knowledge base')
    expect(msg.content[1].text).toContain('El paquete incluye')
    expect(msg.content[1]).not.toHaveProperty('cache_control')
  })

  it('without caching, sends the plain string exactly as before', () => {
    expect(systemMessageFor(withKnowledge, false)).toEqual({ role: 'system', content: withKnowledge })
  })
})

describe('generateOpenAiCompatible with prompt caching', () => {
  const args = {
    apiKey: 'k',
    systemPrompt: buildSystemPrompt({ userPrompt: 'Negocio', mode: 'auto_reply' as const }),
    messages: [{ role: 'user' as const, content: 'Hola' }],
    timeoutMs: 5000,
    baseUrl: 'https://openrouter.ai/api/v1',
  }

  it('marks the system prompt cacheable for Claude on OpenRouter', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    const res = await generateOpenAiCompatible({ ...args, model: 'anthropic/claude-haiku-5.5' })
    expect(res.text).toBe('Hola')
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(systemText(body)).toBe(args.systemPrompt)
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'Hola' }])
  })

  it('falls back to the plain request when the cached one is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"bad"}', { status: 400 }))
      .mockResolvedValueOnce(ok('Respuesta'))
    vi.stubGlobal('fetch', fetchMock)
    const res = await generateOpenAiCompatible({ ...args, model: 'anthropic/claude-haiku-5.5' })
    expect(res.text).toBe('Respuesta')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1].body))
    expect(retry.messages[0]).toEqual({ role: 'system', content: args.systemPrompt })
  })

  it('leaves other models untouched (one plain request)', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAiCompatible({ ...args, model: 'openai/gpt-5-mini' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.messages[0]).toEqual({ role: 'system', content: args.systemPrompt })
  })

  it('does not retry other errors (e.g. a bad key)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAiCompatible({ ...args, model: 'anthropic/claude-haiku-5.5' })).rejects.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('consistent replies (low temperature)', () => {
  const base = {
    apiKey: 'k',
    systemPrompt: 'Instrucciones',
    messages: [{ role: 'user' as const, content: 'Holaa' }],
    timeoutMs: 5000,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-haiku-5.5',
  }

  it('asks for a low temperature', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok())
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAiCompatible(base)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.temperature).toBe(REPLY_TEMPERATURE)
    expect(REPLY_TEMPERATURE).toBeLessThanOrEqual(0.3)
  })

  it('retries without temperature or cache when a model rejects them', async () => {
    const fetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('{"error":"temperature not supported"}', { status: 400 }))
      .mockResolvedValueOnce(ok('Hola'))
    vi.stubGlobal('fetch', fetchMock)
    const res = await generateOpenAiCompatible({ ...base, model: 'openai/o9' })
    expect(res.text).toBe('Hola')
    const retry = JSON.parse(String(fetchMock.mock.calls[1][1].body))
    expect(retry).not.toHaveProperty('temperature')
    expect(retry.messages[0]).toEqual({ role: 'system', content: 'Instrucciones' })
  })
})
