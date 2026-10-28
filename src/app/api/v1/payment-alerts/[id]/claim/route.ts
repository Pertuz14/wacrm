// ============================================================
// POST /api/v1/payment-alerts/{id}/claim — take an APPROVED alert to
// register it (scope: sales:write). approved → processing, atomically,
// so it is registered only once. 409 when it isn't approved (the owner
// hasn't tapped "Habilitar acceso", or it was already taken).
// Response: { data: { id, fields, phone } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { UUID_RE, type PaymentAlertRow } from '@/lib/ai/payment-alerts'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'sales:write')
    const { id } = await params
    if (!UUID_RE.test(id)) return fail('not_found', 'Payment alert not found', 404)
    const { data } = await ctx.supabase
      .from('payment_alerts')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .eq('status', 'approved')
      .select('*')
      .maybeSingle()
    const row = data as PaymentAlertRow | null
    if (!row) return fail('conflict', 'Payment alert is not approved', 409)
    return ok({ id: row.id, fields: row.fields, phone: row.phone })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
