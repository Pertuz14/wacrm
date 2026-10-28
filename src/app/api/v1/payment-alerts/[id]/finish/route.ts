// ============================================================
// POST /api/v1/payment-alerts/{id}/finish — close an alert (scope: sales:write)
//
// Body: { "ok": true, "summary": "..." }   → done; the Telegram alert
//                                             shows "✅ Acceso habilitado"
//       { "ok": false, "error": "..." }    → back to pending; Telegram
//                                             shows the error + buttons
// 409 when it was already done.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { finishAlert, loadAlert } from '@/lib/ai/payment-alerts'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'sales:write')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as
      | { ok?: unknown; summary?: unknown; error?: unknown }
      | null
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400)
    }
    const row = await loadAlert(ctx.supabase, id, ctx.accountId)
    if (!row) return fail('not_found', 'Payment alert not found', 404)
    if (row.status === 'done') return fail('conflict', 'Payment alert already done', 409)

    const updated = await finishAlert(ctx.supabase, row, {
      ok: body.ok === true,
      summary: typeof body.summary === 'string' ? body.summary : null,
      error: typeof body.error === 'string' ? body.error : null,
    })
    return ok({ id: updated.id, status: updated.status })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
