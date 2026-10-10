import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadPricing } from '@/lib/ai/exchange-rate'
import { pricingResponse } from '@/lib/ai/pricing-response'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/pricing/refresh  (admin+)
 *
 * "Update now": fetch the official rate immediately instead of waiting
 * for the hourly check. No-op for a manual rate.
 */
export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-pricing-refresh:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const state = await loadPricing(supabaseAdmin(), accountId, { refresh: 'force' })
    if (!state) {
      return NextResponse.json({ error: t('ai.pricingNotSaved') }, { status: 400 })
    }
    return NextResponse.json(pricingResponse(state))
  } catch (err) {
    return toErrorResponse(err)
  }
}
