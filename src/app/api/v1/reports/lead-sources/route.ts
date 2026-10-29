// ============================================================
// GET /api/v1/reports/lead-sources?days=180      (scope: reports:read)
//
// Where customers came from (ads, web, TikTok, Instagram…) and how far
// each got in each program's pipeline. No names or phones. Read by the
// owner's script that writes the report into the Obsidian vault.
//
// Query: days — period to cover, 1..730 (default 180).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { buildLeadSourceReport } from '@/lib/leads/report';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'reports:read');
    const raw = new URL(request.url).searchParams.get('days');
    const days = raw === null ? 180 : Math.floor(Number(raw));
    if (!Number.isFinite(days) || days < 1 || days > 730) {
      return fail('bad_request', "'days' must be between 1 and 730", 400);
    }
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return ok(await buildLeadSourceReport(ctx.supabase, ctx.accountId, since));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
