// ============================================================
// POST /api/meta/capi/flush — send the queued Meta events (migration 075)
//
// Called every 5 minutes by pg_cron + pg_net from Supabase
// (crm/«Supabase 5 - envío a Meta cada 5 minutos.sql») with the header
// x-capi-secret = META_CAPI_FLUSH_SECRET. Nothing leaves while
// META_CAPI_ACTIVO is off; old rows still expire.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { capiConfig } from '@/lib/meta/capi'
import { flushCapiQueue } from '@/lib/meta/capi-queue'

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function POST(request: Request) {
  const cfg = capiConfig()
  const given = request.headers.get('x-capi-secret') ?? ''
  if (!cfg.flushSecret || !sameSecret(given, cfg.flushSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  const summary = await flushCapiQueue(supabaseAdmin(), cfg)
  return NextResponse.json({ ok: true, active: cfg.active, test: Boolean(cfg.testCode), ...summary })
}
