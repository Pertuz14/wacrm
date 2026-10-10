import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadPricing } from '@/lib/ai/exchange-rate'
import { PriceItemsError, todayInCaracas, validatePriceItems } from '@/lib/ai/pricing'
import { pricingResponse } from '@/lib/ai/pricing-response'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const MAX_MANUAL_RATE = 10_000_000

/**
 * GET /api/ai/pricing  (any member)
 *
 * The account's exchange rate + price list, refreshing an automatic rate
 * when stale. The refresh writes through the service role (a plain agent
 * may view the page but cannot update the row under RLS); tenancy comes
 * from the session.
 */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const state = await loadPricing(supabaseAdmin(), accountId)
    return NextResponse.json(pricingResponse(state))
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/pricing  (admin+)
 *
 * Body: { auto_update: boolean, manual_rate?: number, items: PriceItem[] }
 * With `auto_update: false` the admin's `manual_rate` is used as today's
 * rate until switched back.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-pricing:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }

    let items
    try {
      items = validatePriceItems(body.items ?? [])
    } catch (err) {
      if (err instanceof PriceItemsError) {
        return NextResponse.json(
          { error: t('ai.pricingInvalid', { detail: err.message }) },
          { status: 400 },
        )
      }
      throw err
    }

    const autoUpdate = body.auto_update !== false
    const now = new Date()
    const row: Record<string, unknown> = {
      account_id: accountId,
      auto_update: autoUpdate,
      items,
      updated_at: now.toISOString(),
    }

    if (!autoUpdate) {
      const manual = Number(body.manual_rate)
      if (!Number.isFinite(manual) || manual <= 0 || manual >= MAX_MANUAL_RATE) {
        return NextResponse.json({ error: t('ai.pricingManualRateRequired') }, { status: 400 })
      }
      Object.assign(row, {
        rate: manual,
        rate_date: todayInCaracas(now),
        rate_source: 'manual',
        next_rate: null,
        next_rate_date: null,
      })
    }

    const { data: existing } = await supabase
      .from('ai_pricing')
      .select('auto_update')
      .eq('account_id', accountId)
      .maybeSingle()
    // Turning automatic updates (back) on: fetch the official rate now
    // rather than keeping the manual one until the next stale check.
    const switchedToAuto =
      autoUpdate && (!existing || (existing as { auto_update: boolean }).auto_update === false)
    if (switchedToAuto) row.checked_at = null

    const { error } = await supabase
      .from('ai_pricing')
      .upsert(row, { onConflict: 'account_id' })
    if (error) {
      console.error('[ai/pricing POST] save failed:', error)
      return NextResponse.json({ error: t('ai.pricingSaveFailed') }, { status: 500 })
    }

    const state = await loadPricing(supabaseAdmin(), accountId, {
      refresh: switchedToAuto ? 'force' : 'if-stale',
    })
    return NextResponse.json(pricingResponse(state))
  } catch (err) {
    return toErrorResponse(err)
  }
}
