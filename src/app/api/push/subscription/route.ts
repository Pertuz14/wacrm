import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { vapidPublicKey } from '@/lib/notifications/web-push'

// Web Push subscriptions for the signed-in user's devices.
//   GET    → { publicKey } (null when push isn't configured on the server)
//   POST   → register / refresh this device's subscription
//   DELETE → remove this device's subscription

export async function GET() {
  try {
    await getCurrentAccount()
    return NextResponse.json({ publicKey: vapidPublicKey() })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface SubscriptionBody {
  endpoint?: unknown
  keys?: { p256dh?: unknown; auth?: unknown }
}

const isPushEndpoint = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('https://') && v.length <= 1000

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as SubscriptionBody | null
  const endpoint = body?.endpoint
  const p256dh = body?.keys?.p256dh
  const auth = body?.keys?.auth
  if (!isPushEndpoint(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }

  const { error } = await supabaseAdmin()
    .from('push_subscriptions')
    .upsert(
      {
        account_id: ctx.accountId,
        user_id: ctx.userId,
        endpoint,
        p256dh,
        auth,
        user_agent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
      },
      { onConflict: 'endpoint' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as SubscriptionBody | null
  if (!isPushEndpoint(body?.endpoint)) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }
  await supabaseAdmin()
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', body.endpoint)
    .eq('user_id', ctx.userId)
  return NextResponse.json({ ok: true })
}
