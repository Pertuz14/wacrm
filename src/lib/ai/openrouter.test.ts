import { describe, it, expect } from 'vitest'
import {
  OPENROUTER_BASE_URL,
  isOpenRouterBaseUrl,
  parseOpenRouterModels,
} from './openrouter'
import { normalizeOpenAiCompatibleBaseUrl } from './providers/openai-compatible'

describe('isOpenRouterBaseUrl', () => {
  it('recognises the canonical base URL and paths under it', () => {
    expect(isOpenRouterBaseUrl(OPENROUTER_BASE_URL)).toBe(true)
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(true)
    expect(isOpenRouterBaseUrl('  https://OpenRouter.ai/api/v1  ')).toBe(true)
  })

  it('rejects other hosts, look-alikes and plain http', () => {
    expect(isOpenRouterBaseUrl('https://api.groq.com/openai/v1')).toBe(false)
    expect(isOpenRouterBaseUrl('https://openrouter.ai.evil.example/api/v1')).toBe(false)
    expect(isOpenRouterBaseUrl('https://evil.example/openrouter.ai')).toBe(false)
    expect(isOpenRouterBaseUrl('http://openrouter.ai/api/v1')).toBe(false)
  })

  it('rejects empty and malformed values', () => {
    expect(isOpenRouterBaseUrl('')).toBe(false)
    expect(isOpenRouterBaseUrl(null)).toBe(false)
    expect(isOpenRouterBaseUrl(undefined)).toBe(false)
    expect(isOpenRouterBaseUrl('not a url')).toBe(false)
  })

  it('uses a base URL the openai-compatible provider accepts as-is', () => {
    expect(normalizeOpenAiCompatibleBaseUrl(OPENROUTER_BASE_URL)).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    )
  })
})

describe('parseOpenRouterModels', () => {
  it('returns models sorted by name, case-insensitively', () => {
    const models = parseOpenRouterModels({
      data: [
        { id: 'z/zeta', name: 'Zeta' },
        { id: 'a/alpha', name: 'alpha' },
        { id: 'm/mid', name: 'Mid' },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['a/alpha', 'm/mid', 'z/zeta'])
  })

  it('falls back to the id when the name is missing', () => {
    expect(parseOpenRouterModels({ data: [{ id: 'x/y' }] })).toEqual([
      { id: 'x/y', name: 'x/y' },
    ])
  })

  it('drops models that cannot output text, but keeps ones with no modality info', () => {
    const models = parseOpenRouterModels({
      data: [
        { id: 'img/gen', name: 'Img', architecture: { output_modalities: ['image'] } },
        { id: 'chat/ok', name: 'Chat', architecture: { output_modalities: ['text'] } },
        { id: 'multi/ok', name: 'Multi', architecture: { output_modalities: ['text', 'image'] } },
        { id: 'plain/ok', name: 'Plain' },
      ],
    })
    expect(models.map((m) => m.id).sort()).toEqual(['chat/ok', 'multi/ok', 'plain/ok'])
  })

  it('de-duplicates by id and skips malformed entries', () => {
    const models = parseOpenRouterModels({
      data: [
        { id: 'dup/one', name: 'First' },
        { id: 'dup/one', name: 'Second' },
        { id: '   ' },
        { id: 42 },
        null,
        'oops',
      ],
    })
    expect(models).toEqual([{ id: 'dup/one', name: 'Second' }])
  })

  it('returns an empty list for unexpected payloads', () => {
    expect(parseOpenRouterModels(null)).toEqual([])
    expect(parseOpenRouterModels({})).toEqual([])
    expect(parseOpenRouterModels({ data: 'nope' })).toEqual([])
    expect(parseOpenRouterModels([])).toEqual([])
  })
})
