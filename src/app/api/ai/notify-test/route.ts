import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isTelegramConfigured, sendTelegramText } from '@/lib/notifications/telegram'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * POST /api/ai/notify-test  (admin+)
 *
 * Sends a test alert to the Telegram chat(s) in TELEGRAM_CHAT_ID, so the
 * owner can confirm the setup before a real payment comes in. Returns
 * Telegram's own error text on failure (e.g. "chat not found" when the
 * bot was never started from that account).
 */
export async function POST() {
  try {
    const { userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-notify-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    if (!isTelegramConfigured()) {
      return NextResponse.json({ error: t('ai.telegramNotConfigured') }, { status: 400 })
    }
    const result = await sendTelegramText(t('ai.telegramTestMessage'))
    if (!result.ok) {
      return NextResponse.json(
        { error: t('ai.telegramTestFailed', { detail: result.error ?? '' }) },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
