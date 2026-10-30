import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

const PRIVATE_HOST_ALLOWLIST_ENV = 'AI_PROVIDER_ALLOWED_PRIVATE_HOSTS'

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function allowedPrivateHosts(): Set<string> {
  return new Set(
    (process.env[PRIVATE_HOST_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map(normalizeHost)
      .filter(Boolean),
  )
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '')
  if (!value) {
    throw new AiError(t('ai.compatBaseUrlRequired'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AiError(t('ai.compatBaseUrlInvalid'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiError(t('ai.compatBaseUrlProtocol'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.protocol === 'http:' && !allowedPrivateHosts().has(normalizeHost(parsed.hostname))) {
    throw new AiError(t('ai.compatBaseUrlHttpsRequired', { envVar: PRIVATE_HOST_ALLOWLIST_ENV }), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.username || parsed.password) {
    throw new AiError(t('ai.compatBaseUrlCredentials'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.search || parsed.hash) {
    throw new AiError(t('ai.compatBaseUrlQuery'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  const normalized = parsed.toString().replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

/**
 * Output budget for OpenAI-compatible APIs. Higher than the shared
 * MAX_OUTPUT_TOKENS because many models behind these APIs (OpenRouter's
 * reasoning models, DeepSeek R1, Gemini 2.5…) spend part of `max_tokens`
 * thinking before they write: with 1024 the thinking can use it all and
 * the reply comes back empty (finish_reason "length"). Replies stay
 * short — the prompt asks for WhatsApp-sized messages — so this only
 * raises the ceiling, not the typical spend.
 */
export const COMPAT_MAX_OUTPUT_TOKENS = Math.max(MAX_OUTPUT_TOKENS, 4096)

type ContentPart = { type?: string; text?: string }

interface OpenAiCompatibleResponse {
  choices?: {
    message?: { content?: string | ContentPart[] | null }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    /** OpenRouter: how many prompt tokens were read from the cache. */
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** `content` is usually a string, but some providers return text parts. */
export function extractContentText(content: string | ContentPart[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * Prompt caching (OpenRouter + Claude only). The system prompt — fixed
 * rules plus the business instructions, tens of thousands of tokens — is
 * identical between replies for hours, so Anthropic can keep it cached:
 * re-sent within ~5 minutes it is read at a fraction of the price and
 * with less latency. The TEXT the model receives is byte-for-byte the
 * same; only a `cache_control` marker is added. Everything else (other
 * providers, other models) is sent exactly as before.
 */
export function wantsPromptCache(endpoint: string, model: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) && /^anthropic\//i.test(model)
  } catch {
    return false
  }
}

/** Where per-question knowledge starts (see buildSystemPrompt): it changes every turn, so it stays out of the cached block. */
const KNOWLEDGE_MARKER = '\n\nKnowledge base — '

type SystemMessage =
  | { role: 'system'; content: string }
  | {
      role: 'system'
      content: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
    }

/**
 * The system message, with the stable prefix marked cacheable when
 * `cache` is on. The parts always concatenate back to `systemPrompt`.
 */
export function systemMessageFor(systemPrompt: string, cache: boolean): SystemMessage {
  if (!cache) return { role: 'system', content: systemPrompt }
  const cut = systemPrompt.indexOf(KNOWLEDGE_MARKER)
  const stable = cut > 0 ? systemPrompt.slice(0, cut) : systemPrompt
  const rest = cut > 0 ? systemPrompt.slice(cut) : ''
  return {
    role: 'system',
    content: [
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      ...(rest ? [{ type: 'text' as const, text: rest }] : []),
    ],
  }
}

export async function generateOpenAiCompatible(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args
  const endpoint = normalizeOpenAiCompatibleBaseUrl(baseUrl ?? '')

  let deliverable = false
  try {
    deliverable = await isDeliverableUrl(endpoint, {
      allowPrivateHosts: allowedPrivateHosts(),
    })
  } catch {
    deliverable = false
  }

  if (!deliverable) {
    throw new AiError(t('ai.compatBlockedUrl', { envVar: PRIVATE_HOST_ALLOWLIST_ENV }), {
      code: 'blocked_url',
      status: 400,
    })
  }

  const conversation = mergeConsecutive(messages)
  const send = (cache: boolean) =>
    fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [systemMessageFor(systemPrompt, cache), ...conversation],
        max_tokens: COMPAT_MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

  const cache = wantsPromptCache(endpoint, model)
  let res: Response
  try {
    res = await send(cache)
    // Never let caching cost a reply: if the provider rejects the cached
    // request shape, send the exact pre-cache request once.
    if (cache && (res.status === 400 || res.status === 422)) {
      console.warn(`[ai] prompt cache request rejected (${res.status}); retrying without cache`)
      res = await send(false)
    }
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await providerHttpError('OpenAI-compatible provider', res)

  const data = (await res.json().catch(() => null)) as OpenAiCompatibleResponse | null
  const choice = data?.choices?.[0]
  const text = extractContentText(choice?.message?.content)
  if (!text.trim()) {
    // Name the finish reason ("length" = the budget ran out, usually on
    // reasoning; "content_filter" = blocked) so the failure is diagnosable.
    const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ''
    console.warn(`[ai] OpenAI-compatible empty response from model "${model}"${reason}`)
    throw new AiError(
      t('ai.emptyResponse', { provider: `OpenAI-compatible provider${reason}` }),
      { code: 'empty_response' },
    )
  }

  if (cache) {
    // Lets the owner check in the server logs that the cache is working.
    const cached = data?.usage?.prompt_tokens_details?.cached_tokens ?? 0
    console.info(`[ai] prompt tokens ${data?.usage?.prompt_tokens ?? '?'}, from cache ${cached}`)
  }

  return {
    text,
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}
