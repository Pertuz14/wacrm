// ============================================================
// Rumbo a la U — local change (see RUMBO.md). Not part of upstream.
//
// What the website saw on a visit (fbc, fbp, IP, browser), asked to the
// store's platform by visit code: POST {RUMBO_PLATFORM_URL}/api/crm/meta-visita
// with the shared secret RUMBO_CHECKOUT_SECRET (= the platform's CHECKOUT_SECRETO).
// Added to the website events of the Conversions API so Meta can tie a
// purchase to the ad click. Best-effort: without the secret, or if the
// platform does not answer, the event goes out as before.
// ============================================================

import { platformUrl } from '@/lib/ai/payment-alerts'
import type { VisitData } from './capi'

const VISIT_RE = /^[a-z0-9]{10}$/

export async function fetchVisitData(visitCode: string, fetcher: typeof fetch = fetch): Promise<VisitData | null> {
  const key = process.env.RUMBO_CHECKOUT_SECRET?.trim()
  if (!key || key.length < 32 || !VISIT_RE.test(visitCode)) return null
  try {
    const res = await fetcher(`${platformUrl()}/api/crm/meta-visita`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ visita: visitCode }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const d = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const str = (x: unknown, max: number) => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null)
    const visit: VisitData = { fbc: str(d?.fbc, 600), fbp: str(d?.fbp, 80), ip: str(d?.ip, 64), userAgent: str(d?.agente, 400) }
    return Object.values(visit).some(Boolean) ? visit : null
  } catch {
    return null
  }
}
