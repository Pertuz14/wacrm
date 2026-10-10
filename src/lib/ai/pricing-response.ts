import type { PricingState } from './exchange-rate'
import { buildPriceVariables, todayInCaracas } from './pricing'
import { isTelegramConfigured } from '@/lib/notifications/telegram'

/** JSON the pricing settings page reads (GET, and after every write). */
export function pricingResponse(state: PricingState | null, now: Date = new Date()) {
  return {
    configured: state !== null,
    auto_update: state?.autoUpdate ?? true,
    rate: state?.rate ?? null,
    rate_date: state?.rateDate ?? null,
    rate_source: state?.rateSource ?? null,
    checked_at: state?.checkedAt ?? null,
    items: state?.items ?? [],
    today: todayInCaracas(now),
    variables: state
      ? buildPriceVariables({
          rate: state.rate,
          rateDate: state.rateDate,
          items: state.items,
          now,
        })
      : {},
    telegram_configured: isTelegramConfigured(),
  }
}

export type PricingResponse = ReturnType<typeof pricingResponse>
