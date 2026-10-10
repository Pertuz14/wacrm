// ============================================================
// Price list + exchange rate → prompt variables.
//
// Prices live in USD; customers pay in bolívares at the official rate of
// the day. The model must never do that arithmetic itself (it gets it
// wrong), so every amount is pre-computed here and substituted into the
// system prompt / knowledge base as `{{VARIABLE}}` placeholders right
// before each model call. Pure functions only — fetching the rate and
// reading the account's row live in exchange-rate.ts.
// ============================================================

/** Venezuela has a single time zone; "today" for prices means Caracas. */
export const PRICING_TIME_ZONE = 'America/Caracas'

export const MAX_PRICE_ITEMS = 50
const MAX_LABEL_LENGTH = 80
const MAX_USD = 1_000_000
/** Variable stem: starts with a letter, then letters/digits/underscores. */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/

export interface PriceItem {
  /** Variable stem, e.g. `P_PAQUETE` → `{{P_PAQUETE_BS}}`. */
  key: string
  label: string
  usd: number
}

export type RateSource = 'bcv' | 'dolarapi' | 'manual'

export interface RateQuote {
  source: RateSource
  /** Bs per USD. */
  rate: number
  /** Value date (`YYYY-MM-DD`) from which the rate applies. */
  date: string
}

/** The suffixes every item expands to, in the order the UI lists them. */
export const ITEM_VARIABLE_SUFFIXES = ['_BS', '_USD', '_BS_COPIAR'] as const

export class PriceItemsError extends Error {}

/**
 * Validate and normalise a price list coming from the settings form.
 * Throws `PriceItemsError` with a message naming the offending row.
 */
export function validatePriceItems(raw: unknown): PriceItem[] {
  if (!Array.isArray(raw)) throw new PriceItemsError('items must be a list')
  if (raw.length > MAX_PRICE_ITEMS) {
    throw new PriceItemsError(`at most ${MAX_PRICE_ITEMS} prices`)
  }
  const seen = new Set<string>()
  return raw.map((entry, i) => {
    const row = i + 1
    const e = (entry ?? {}) as { key?: unknown; label?: unknown; usd?: unknown }
    const key = typeof e.key === 'string' ? e.key.trim().toUpperCase() : ''
    if (!KEY_PATTERN.test(key)) {
      throw new PriceItemsError(`row ${row}: invalid variable name`)
    }
    if (seen.has(key)) throw new PriceItemsError(`row ${row}: duplicate variable ${key}`)
    seen.add(key)
    const label = typeof e.label === 'string' ? e.label.trim().slice(0, MAX_LABEL_LENGTH) : ''
    const usd = typeof e.usd === 'number' ? e.usd : Number(e.usd)
    if (!Number.isFinite(usd) || usd < 0 || usd > MAX_USD) {
      throw new PriceItemsError(`row ${row}: invalid USD amount`)
    }
    return { key, label, usd: roundTo(usd, 2) }
  })
}

/** Lenient read of a stored list (skips anything malformed). */
export function readStoredPriceItems(raw: unknown): PriceItem[] {
  if (!Array.isArray(raw)) return []
  const out: PriceItem[] = []
  for (const entry of raw) {
    try {
      out.push(...validatePriceItems([entry]))
    } catch {
      // skip
    }
  }
  return out
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round((value + Number.EPSILON) * f) / f
}

/** USD × rate, rounded to cents. */
export function usdToBs(usd: number, rate: number): number {
  return roundTo(usd * rate, 2)
}

/** Venezuelan formatting: `43.782,53` (dot thousands, comma decimals). */
export function formatBs(amount: number): string {
  const [int, dec] = roundTo(amount, 2).toFixed(2).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${grouped},${dec}`
}

/**
 * Bank-friendly amount for copy-paste into a payment app: no thousands
 * separator, comma decimals (`43782,53`).
 */
export function formatBsPlain(amount: number): string {
  return roundTo(amount, 2).toFixed(2).replace('.', ',')
}

/** `50` or `27,50` — whole dollars stay whole, otherwise two decimals. */
export function formatUsd(amount: number): string {
  const r = roundTo(amount, 2)
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace('.', ',')
}

/** `YYYY-MM-DD` for `now` in Caracas. */
export function todayInCaracas(now: Date = new Date()): string {
  // en-CA renders ISO-style dates.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PRICING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** `sábado, 10 de octubre de 2026` for `now` in Caracas. */
export function longSpanishDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: PRICING_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)
}

/** `13/10/2026` for an ISO date, without time-zone drift. */
export function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return y && m && d ? `${d}/${m}/${y}` : isoDate
}

/**
 * Pick the rate to charge: the latest one the BCV published, i.e. the
 * newest value date — even when that date is still ahead (the BCV
 * publishes the next business day's rate in the afternoon, and the
 * business charges it as soon as it is out). Ties go to the BCV, the
 * authority; among equals the earlier entry wins, so fresh quotes listed
 * before a stored one replace it.
 */
export function chooseRate(quotes: (RateQuote | null)[]): RateQuote | null {
  const sourceRank = (q: RateQuote) => (q.source === 'bcv' ? 0 : 1)
  return (
    quotes
      .filter((q): q is RateQuote => q !== null)
      .sort((a, b) => b.date.localeCompare(a.date) || sourceRank(a) - sourceRank(b))[0] ?? null
  )
}

/**
 * Every `{{VARIABLE}}` the prompt can use, with its value for today.
 * Without a rate only the date and the USD amounts are available, so the
 * Bs placeholders stay visible (and the model is told not to invent them)
 * rather than turning into a wrong number.
 */
export function buildPriceVariables(args: {
  rate: number | null
  rateDate: string | null
  items: PriceItem[]
  now?: Date
}): Record<string, string> {
  const { rate, rateDate, items, now = new Date() } = args
  const vars: Record<string, string> = {
    FECHA_HOY: longSpanishDate(now),
  }
  if (rate) {
    vars.TASA_BCV = formatBs(rate)
    if (rateDate) vars.FECHA_TASA = shortDate(rateDate)
  }
  for (const item of items) {
    vars[`${item.key}_USD`] = formatUsd(item.usd)
    if (rate) {
      const bs = usdToBs(item.usd, rate)
      vars[`${item.key}_BS`] = formatBs(bs)
      vars[`${item.key}_BS_COPIAR`] = formatBsPlain(bs)
    }
  }
  return vars
}

/**
 * Replace `{{NAME}}` (spaces inside the braces allowed) with its value.
 * Unknown names are left untouched so a typo stays visible instead of
 * silently becoming an empty string.
 */
export function applyTemplateVariables(
  text: string,
  vars: Record<string, string>,
): string {
  if (!text || Object.keys(vars).length === 0) return text
  return text.replace(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  )
}
