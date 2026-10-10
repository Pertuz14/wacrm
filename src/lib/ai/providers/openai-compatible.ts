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

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...mergeConsecutive(messages)],
        max_tokens: COMPAT_MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
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

  return {
    text,
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}
