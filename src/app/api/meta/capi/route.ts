// ============================================================
// /api/meta/capi — the owner's view of the Conversions API (migration 075)
//
//   GET  → what is configured (yes/no, never the values), counts by
//          status and the last 30 events with their reason.
//   POST → { "action": "flush" } sends what is pending now (same as the
//          5-minute schedule). Only the owner.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { capiConfig } from '@/lib/meta/capi'
import { flushCapiQueue } from '@/lib/meta/capi-queue'

export async function GET() {
  try {
    const ctx = await requireRole('owner')
    const cfg = capiConfig()
    const db = supabaseAdmin()
    const { data: rows } = await db
      .from('capi_events')
      .select('event_name, channel, status, reason, value_usd, test_mode, occurred_at, sent_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(30)
    const counts: Record<string, number> = {}
    for (const status of ['pending', 'sent', 'skipped', 'error', 'expired']) {
      const { count } = await db
        .from('capi_events')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('status', status)
      counts[status] = count ?? 0
    }
    return NextResponse.json({
      config: {
        active: cfg.active,
        test: Boolean(cfg.testCode),
        token: Boolean(cfg.token),
        datasets: {
          whatsapp: Boolean(cfg.datasets.whatsapp),
          instagram: Boolean(cfg.datasets.instagram),
          website: Boolean(cfg.datasets.website),
        },
        flushSecret: Boolean(cfg.flushSecret),
      },
      counts,
      events: rows ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    await requireRole('owner')
    const body = (await request.json().catch(() => null)) as { action?: string } | null
    if (body?.action !== 'flush') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    const cfg = capiConfig()
    const summary = await flushCapiQueue(supabaseAdmin(), cfg)
    return NextResponse.json({ ok: true, active: cfg.active, test: Boolean(cfg.testCode), ...summary })
  } catch (err) {
    return toErrorResponse(err)
  }
}
