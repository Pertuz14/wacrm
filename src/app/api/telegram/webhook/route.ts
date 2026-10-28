// ============================================================
// POST /api/telegram/webhook — button taps on the owner's alerts
//
// Registered automatically (setWebhook) when a payment alert is sent.
// Telegram proves itself with X-Telegram-Bot-Api-Secret-Token (derived
// from the bot token). Only taps in the owner's chat (first id in
// TELEGRAM_CHAT_ID) count.
//
// "✅ Habilitar acceso" (pa:<alert id>): pending → approved, then the
// platform is asked to register it; it pulls the alert with its own API
// key, registers the sale and closes the alert (finish), which edits
// the Telegram message with the outcome.
// ============================================================

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  answerTelegramCallback,
  telegramOwnerChatId,
  telegramWebhookSecret,
} from '@/lib/notifications/telegram'
import {
  APPROVE_RE,
  finishAlert,
  loadAlert,
  requestRegistration,
  showOnTelegram,
  type PaymentAlertRow,
} from '@/lib/ai/payment-alerts'

interface CallbackQuery {
  id: string
  data?: string
  from?: { id?: number }
  message?: { chat?: { id?: number } }
}

const STATUS_TEXT: Record<string, string> = {
  done: 'Este acceso ya estaba registrado.',
  approved: 'Ya se está registrando.',
  processing: 'Ya se está registrando.',
}

export async function POST(request: Request) {
  const secret = await telegramWebhookSecret()
  if (!secret || request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const update = (await request.json().catch(() => null)) as { callback_query?: CallbackQuery } | null
  const cq = update?.callback_query
  if (!cq?.id) return NextResponse.json({ ok: true })

  try {
    const match = APPROVE_RE.exec(String(cq.data ?? ''))
    const owner = telegramOwnerChatId()
    if (!match || !owner || String(cq.message?.chat?.id ?? '') !== owner) {
      await answerTelegramCallback(cq.id, 'Este botón no está disponible aquí.')
      return NextResponse.json({ ok: true })
    }

    const id = match[1]
    const db = supabaseAdmin()
    // Atomic: two taps (or a Telegram retry) approve it only once
    const { data } = await db
      .from('payment_alerts')
      .update({ status: 'approved', error: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()
    const approved = data as PaymentAlertRow | null
    if (!approved) {
      const current = await loadAlert(db, id)
      await answerTelegramCallback(cq.id, current ? STATUS_TEXT[current.status] ?? 'No se pudo.' : 'No encontré ese aviso.')
      return NextResponse.json({ ok: true })
    }

    await answerTelegramCallback(cq.id, 'Registrando el acceso…')
    await showOnTelegram(approved, '⏳ Registrando el acceso…')
    await requestRegistration(id)

    // The platform closes the alert itself (and edits the message). If it
    // never took it, or died halfway, say so and let the owner retry.
    const after = await loadAlert(db, id)
    if (after?.status === 'approved') {
      await finishAlert(db, after, { ok: false, error: 'No pude conectar con la plataforma. Intente de nuevo en un momento.' })
    } else if (after?.status === 'processing') {
      await finishAlert(db, after, {
        ok: false,
        error: 'La plataforma no confirmó el registro. Revise en la lista de accesos si quedó registrado antes de intentarlo otra vez.',
      })
    }
  } catch (err) {
    console.error('[telegram webhook] failed:', err)
  }
  return NextResponse.json({ ok: true })
}
