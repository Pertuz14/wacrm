import type { SupabaseClient } from '@supabase/supabase-js'
import { LEAD_SOURCE_LABELS, type LeadSource } from './source'

// ============================================================
// Where a buyer came from, for the sale the platform registers from a
// payment alert (GET /api/v1/payment-alerts/{id}, claim, and the preview).
//
// Rule: the latest arrival with a real origin (an ad, the web, TikTok, a
// post…); a plain «WhatsApp directo» message or «sin dato» only counts
// when there is nothing else. Best-effort: null on any error.
// ============================================================

export interface SaleOrigin {
  source: LeadSource
  label: string
  detail: string | null
  adId: string | null
}

interface LeadSourceRow {
  source: string
  detail: string | null
  ad_id: string | null
  created_at: string
}

const WEAK = new Set(['whatsapp', 'sin_dato'])

/** Pick the origin from the contact's arrivals (any order). Exported for tests. */
export function pickSaleOrigin(rows: LeadSourceRow[]): SaleOrigin | null {
  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  const row = sorted.find((r) => !WEAK.has(r.source)) ?? sorted[0]
  const source = (Object.prototype.hasOwnProperty.call(LEAD_SOURCE_LABELS, row.source) ? row.source : 'otro') as LeadSource
  return { source, label: LEAD_SOURCE_LABELS[source], detail: row.detail ?? null, adId: row.ad_id ?? null }
}

export async function saleOrigin(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null | undefined,
): Promise<SaleOrigin | null> {
  if (!contactId) return null
  try {
    const { data, error } = await db
      .from('lead_sources')
      .select('source, detail, ad_id, created_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) return null
    return pickSaleOrigin((data ?? []) as LeadSourceRow[])
  } catch {
    return null
  }
}
