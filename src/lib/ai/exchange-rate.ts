import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildPriceVariables,
  chooseRate,
  readStoredPriceItems,
  type PriceItem,
  type RateQuote,
  type RateSource,
} from './pricing'

// ============================================================
// Official BCV exchange rate: fetching + the account's ai_pricing row.
//
// Refresh is lazy — no cron to configure. Whenever the assistant builds a
// prompt (or the settings page loads) and the stored rate was last
// checked more than REFRESH_AFTER_MS ago, it is re-fetched. A failed
// fetch never blocks a reply: the last known rate keeps being used.
// ============================================================

export const BCV_URL = 'https://www.bcv.org.ve/'
export const DOLARAPI_URL = 'https://ve.dolarapi.com/v1/dolares/oficial'

const FETCH_TIMEOUT_MS = 8_000
export const REFRESH_AFTER_MS = 60 * 60 * 1000

/** Reject anything that cannot be a Bs/USD rate (parse errors, garbage). */
function plausibleRate(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 10_000_000
}

/** `876,79760000` / `1.234,56` → number. */
function parseVenezuelanNumber(raw: string): number {
  return Number(raw.replace(/\./g, '').replace(',', '.'))
}

/** Parse the USD rate and its "Fecha Valor" out of the BCV homepage HTML. */
export function parseBcvHomepage(html: string): RateQuote | null {
  const rateMatch = html.match(/id="dolar"[\s\S]*?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/)
  const dateMatch = html.match(/Fecha Valor:[\s\S]{0,300}?content="(\d{4}-\d{2}-\d{2})/)
  if (!rateMatch || !dateMatch) return null
  const rate = parseVenezuelanNumber(rateMatch[1])
  if (!plausibleRate(rate)) return null
  return { source: 'bcv', rate, date: dateMatch[1] }
}

/** Parse DolarApi's `{ promedio, fechaActualizacion }` payload. */
export function parseDolarApi(payload: unknown): RateQuote | null {
  if (!payload || typeof payload !== 'object') return null
  const { promedio, fechaActualizacion } = payload as {
    promedio?: unknown
    fechaActualizacion?: unknown
  }
  const rate = typeof promedio === 'number' ? promedio : Number(promedio)
  if (!plausibleRate(rate) || typeof fechaActualizacion !== 'string') return null
  const date = fechaActualizacion.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return { source: 'dolarapi', rate, date }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/** Both sources in parallel; each is null when unreachable or unparsable. */
export async function fetchRateQuotes(): Promise<(RateQuote | null)[]> {
  const [bcvHtml, apiText] = await Promise.all([fetchText(BCV_URL), fetchText(DOLARAPI_URL)])
  let api: RateQuote | null = null
  if (apiText) {
    try {
      api = parseDolarApi(JSON.parse(apiText))
    } catch {
      api = null
    }
  }
  return [bcvHtml ? parseBcvHomepage(bcvHtml) : null, api]
}

export interface PricingState {
  autoUpdate: boolean
  rate: number | null
  rateDate: string | null
  rateSource: RateSource | null
  nextRate: number | null
  nextRateDate: string | null
  checkedAt: string | null
  items: PriceItem[]
}

interface PricingRow {
  auto_update: boolean
  rate: number | string | null
  rate_date: string | null
  rate_source: RateSource | null
  next_rate: number | string | null
  next_rate_date: string | null
  checked_at: string | null
  items: unknown
}

const SELECT_COLUMNS =
  'auto_update, rate, rate_date, rate_source, next_rate, next_rate_date, checked_at, items'

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function rowToState(row: PricingRow | null): PricingState {
  return {
    autoUpdate: row?.auto_update ?? true,
    rate: toNumber(row?.rate ?? null),
    rateDate: row?.rate_date ?? null,
    rateSource: row?.rate_source ?? null,
    nextRate: toNumber(row?.next_rate ?? null),
    nextRateDate: row?.next_rate_date ?? null,
    checkedAt: row?.checked_at ?? null,
    items: readStoredPriceItems(row?.items),
  }
}

/**
 * Apply freshly fetched quotes to the stored state: keep the latest
 * published rate. A missing quote keeps the stored rate (an outage must
 * not wipe the price list), and an older quote — DolarApi lags the BCV by
 * a day — never replaces a newer stored one.
 */
export function mergeQuotes(
  state: PricingState,
  quotes: (RateQuote | null)[],
  now: Date = new Date(),
): PricingState {
  const stored: RateQuote | null =
    state.rate && state.rateDate && state.rateSource && state.rateSource !== 'manual'
      ? { source: state.rateSource, rate: state.rate, date: state.rateDate }
      : null
  const latest = chooseRate([...quotes, stored])
  return {
    ...state,
    rate: latest?.rate ?? state.rate,
    rateDate: latest?.date ?? state.rateDate,
    rateSource: latest?.source ?? state.rateSource,
    // Only meaningful for a "rate in force" policy; the latest published
    // rate is always the one charged, so nothing is pending.
    nextRate: null,
    nextRateDate: null,
    checkedAt: now.toISOString(),
  }
}

function isStale(state: PricingState, now: Date): boolean {
  if (!state.checkedAt) return true
  const last = Date.parse(state.checkedAt)
  return !Number.isFinite(last) || now.getTime() - last > REFRESH_AFTER_MS
}

/**
 * Read the account's pricing row, refreshing the rate first when it is
 * automatic and stale (or always, with `force`). Returns null when the
 * account never set up pricing. Never throws on a network failure.
 * `db` must be able to write the row (service role or an admin session).
 */
export async function loadPricing(
  db: SupabaseClient,
  accountId: string,
  options: { refresh?: 'if-stale' | 'force' | 'never'; now?: Date } = {},
): Promise<PricingState | null> {
  const { refresh = 'if-stale', now = new Date() } = options
  const { data, error } = await db
    .from('ai_pricing')
    .select(SELECT_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null

  const state = rowToState(data as PricingRow)
  const shouldRefresh =
    state.autoUpdate && (refresh === 'force' || (refresh === 'if-stale' && isStale(state, now)))
  if (!shouldRefresh) return state

  const merged = mergeQuotes(state, await fetchRateQuotes(), now)
  const { error: updateErr } = await db
    .from('ai_pricing')
    .update({
      rate: merged.rate,
      rate_date: merged.rateDate,
      rate_source: merged.rateSource,
      next_rate: merged.nextRate,
      next_rate_date: merged.nextRateDate,
      checked_at: merged.checkedAt,
      updated_at: now.toISOString(),
    })
    .eq('account_id', accountId)
  if (updateErr) console.error('[ai pricing] could not store refreshed rate:', updateErr)
  return merged
}

/**
 * The `{{VARIABLE}}` values for this account's prompt, refreshing the
 * rate when stale. Best-effort: any failure yields `{}` (the prompt goes
 * out unsubstituted rather than the reply failing).
 */
export async function loadPromptVariables(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  try {
    const state = await loadPricing(db, accountId, { now })
    if (!state) return {}
    return buildPriceVariables({
      rate: state.rate,
      rateDate: state.rateDate,
      items: state.items,
      now,
    })
  } catch (err) {
    console.error('[ai pricing] prompt variables unavailable:', err)
    return {}
  }
}
