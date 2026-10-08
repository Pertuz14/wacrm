// ============================================================
// OpenRouter support.
//
// OpenRouter is not a separate provider on the backend: it speaks the
// OpenAI chat-completions protocol, so a config that uses it is stored
// as `provider = 'openai_compatible'` with this base URL. That keeps the
// schema, the validation and the generation path untouched — this module
// is the single place that knows the URL, so the settings UI can offer
// OpenRouter as its own choice and recognise it again after a reload.
// ============================================================

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`

/** Placeholder only — OpenRouter model ids are `<vendor>/<model>`. */
export const OPENROUTER_EXAMPLE_MODEL = 'openai/gpt-4o-mini'

/** True when `baseUrl` points at OpenRouter (any path under openrouter.ai). */
export function isOpenRouterBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl.trim())
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'openrouter.ai'
  } catch {
    return false
  }
}

export interface OpenRouterModel {
  id: string
  name: string
}

/**
 * Normalise the `GET /models` payload into a sorted, de-duplicated list
 * of chat-capable models. Defensive on purpose: the response is third
 * party data, so anything that is not a well-formed entry is skipped
 * rather than trusted.
 */
export function parseOpenRouterModels(payload: unknown): OpenRouterModel[] {
  const data =
    payload && typeof payload === 'object'
      ? (payload as { data?: unknown }).data
      : undefined
  if (!Array.isArray(data)) return []

  const byId = new Map<string, OpenRouterModel>()
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const { id, name, architecture } = entry as {
      id?: unknown
      name?: unknown
      architecture?: { output_modalities?: unknown }
    }
    if (typeof id !== 'string' || !id.trim()) continue

    // Image/audio generators cannot answer a chat reply. Only filter when
    // the field is present, so a response without it still lists the model.
    const outputs = architecture?.output_modalities
    if (Array.isArray(outputs) && !outputs.includes('text')) continue

    const cleanId = id.trim()
    byId.set(cleanId, {
      id: cleanId,
      name: typeof name === 'string' && name.trim() ? name.trim() : cleanId,
    })
  }

  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  )
}
