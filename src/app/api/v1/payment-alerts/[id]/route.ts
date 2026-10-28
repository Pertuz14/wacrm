// ============================================================
// GET /api/v1/payment-alerts/{id} — a stored payment alert (scope: sales:write)
//
// The store's platform reads it to pre-fill its sale form
// ("📝 Revisar en el formulario" button). See migration 052.
// Response: { data: { id, status, fields, phone, summary, error, created_at } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { loadAlert } from '@/lib/ai/payment-alerts'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'sales:write')
    const { id } = await params
    const row = await loadAlert(ctx.supabase, id, ctx.accountId)
    if (!row) return fail('not_found', 'Payment alert not found', 404)
    return ok({
      id: row.id,
      status: row.status,
      fields: row.fields,
      phone: row.phone,
      summary: row.summary,
      error: row.error,
    })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
