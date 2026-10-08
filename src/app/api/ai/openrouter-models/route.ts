import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  OPENROUTER_MODELS_URL,
  parseOpenRouterModels,
  type OpenRouterModel,
} from '@/lib/ai/openrouter'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

// The catalogue is public and identical for everyone, so one copy per
// server instance is enough. GET route handlers are not cached by Next,
// hence the explicit in-memory cache.
let cache: { at: number; models: OpenRouterModel[] } | null = null

/**
 * GET /api/ai/openrouter-models  (admin+)
 *
 * Proxies OpenRouter's public model catalogue to the settings form so an
 * admin can search every model. It goes through the server because the
 * app's CSP (`connect-src`) does not allow the browser to call
 * openrouter.ai directly. No API key is sent or needed.
 */
export async function GET() {
  try {
    const { userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-openrouter-models:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json({ models: cache.models })
    }

    let models: OpenRouterModel[] = []
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.ok) models = parseOpenRouterModels(await res.json().catch(() => null))
    } catch {
      // fall through to the error response below
    }

    if (models.length === 0) {
      // Serve a stale copy rather than fail when OpenRouter is down.
      if (cache) return NextResponse.json({ models: cache.models })
      return NextResponse.json({ error: t('ai.openRouterModelsFailed') }, { status: 502 })
    }

    cache = { at: Date.now(), models }
    return NextResponse.json({ models })
  } catch (err) {
    return toErrorResponse(err)
  }
}
