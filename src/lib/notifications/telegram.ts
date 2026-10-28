// ============================================================
// Owner alerts over Telegram.
//
// Telegram rather than WhatsApp because a WhatsApp Business number may
// only message someone freely within 24h of that person writing to it;
// outside that window it needs a pre-approved template. A Telegram bot
// can message its owner at any time, for free, with photos.
//
// Configured with two environment variables (no UI, nothing stored):
//   TELEGRAM_BOT_TOKEN — from @BotFather
//   TELEGRAM_CHAT_ID   — who receives the alerts; comma-separated for
//                        several people (e.g. owner + team member)
//
// Every function is best-effort: it returns false instead of throwing,
// because an alert must never break the reply to a customer.
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org'
const TIMEOUT_MS = 15_000
/** Telegram's limits for message text and photo captions. */
const MAX_TEXT = 4096
const MAX_CAPTION = 1024
/** sendPhoto accepts up to 10 MB; larger images go as a document. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024

interface TelegramConfig {
  token: string
  chatIds: string[]
}

export function getTelegramConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatIds = (process.env.TELEGRAM_CHAT_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!token || chatIds.length === 0) return null
  return { token, chatIds }
}

export function isTelegramConfigured(): boolean {
  return getTelegramConfig() !== null
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

async function call(
  config: TelegramConfig,
  method: string,
  body: FormData | Record<string, unknown>,
): Promise<{ ok: boolean; description?: string }> {
  try {
    const isForm = body instanceof FormData
    const res = await fetch(`${TELEGRAM_API}/bot${config.token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string }
      | null
    return { ok: res.ok && data?.ok === true, description: data?.description }
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) }
  }
}

/** Like `call`, but also returns Telegram's `result` (e.g. the sent message). */
async function callJson<T>(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${config.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string }
      | null
    return { ok: res.ok && data?.ok === true, result: data?.result, description: data?.description }
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) }
  }
}

export interface TelegramResult {
  ok: boolean
  /** Telegram's error text for the first failure, for the test button. */
  error?: string
}

/** Plain-text message (no Markdown, so customer text can't break it). */
export async function sendTelegramText(text: string): Promise<TelegramResult> {
  const config = getTelegramConfig()
  if (!config) return { ok: false, error: 'not_configured' }
  let error: string | undefined
  for (const chatId of config.chatIds) {
    const r = await call(config, 'sendMessage', {
      chat_id: chatId,
      text: truncate(text, MAX_TEXT),
      link_preview_options: { is_disabled: true },
    })
    if (!r.ok && !error) error = r.description ?? 'send_failed'
  }
  return error ? { ok: false, error } : { ok: true }
}

/** An image with a short caption; falls back to a document when large. */
export async function sendTelegramImage(args: {
  bytes: Uint8Array<ArrayBuffer>
  mimeType: string
  fileName: string
  caption?: string
}): Promise<TelegramResult> {
  const config = getTelegramConfig()
  if (!config) return { ok: false, error: 'not_configured' }
  const asPhoto = args.mimeType.startsWith('image/') && args.bytes.byteLength <= MAX_PHOTO_BYTES
  const method = asPhoto ? 'sendPhoto' : 'sendDocument'
  const field = asPhoto ? 'photo' : 'document'
  let error: string | undefined
  for (const chatId of config.chatIds) {
    const form = new FormData()
    form.append('chat_id', chatId)
    if (args.caption) form.append('caption', truncate(args.caption, MAX_CAPTION))
    form.append(field, new Blob([args.bytes], { type: args.mimeType }), args.fileName)
    const r = await call(config, method, form)
    if (!r.ok && !error) error = r.description ?? 'send_failed'
  }
  return error ? { ok: false, error } : { ok: true }
}

// ── Buttons under an alert (one-tap "enable access") ─────────────
// Telegram calls back POST /api/telegram/webhook when a button is
// tapped. Only the FIRST id in TELEGRAM_CHAT_ID (the owner) gets the
// action buttons and may use them; other chats get the plain alert.

export type TelegramButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }

/** One button per row. */
function keyboard(buttons: TelegramButton[] | undefined) {
  return buttons?.length ? { inline_keyboard: buttons.map((b) => [b]) } : undefined
}

export function telegramOwnerChatId(): string | null {
  return getTelegramConfig()?.chatIds[0] ?? null
}

/**
 * Secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every
 * webhook call. Derived from the bot token, so there is nothing extra to
 * configure, and a caller without the token cannot forge it.
 */
export async function telegramWebhookSecret(): Promise<string | null> {
  const config = getTelegramConfig()
  if (!config) return null
  const data = new TextEncoder().encode(`wacrm-telegram-webhook:${config.token}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 64)
}

export interface SentMessage {
  chat_id: string
  message_id: number
}

/**
 * The alert text to every chat; only the owner's copy carries `buttons`.
 * Returns where each copy landed (to edit it later).
 */
export async function sendTelegramTextWithButtons(
  text: string,
  buttons: TelegramButton[],
): Promise<TelegramResult & { sent: SentMessage[] }> {
  const config = getTelegramConfig()
  if (!config) return { ok: false, error: 'not_configured', sent: [] }
  const sent: SentMessage[] = []
  let error: string | undefined
  for (const [i, chatId] of config.chatIds.entries()) {
    const r = await callJson<{ message_id: number }>(config, 'sendMessage', {
      chat_id: chatId,
      text: truncate(text, MAX_TEXT),
      link_preview_options: { is_disabled: true },
      reply_markup: i === 0 ? keyboard(buttons) : undefined,
    })
    if (r.ok && r.result) sent.push({ chat_id: chatId, message_id: r.result.message_id })
    else if (!error) error = r.description ?? 'send_failed'
  }
  return error ? { ok: false, error, sent } : { ok: true, sent }
}

/** Replace a sent message's text (and its buttons; none removes them). */
export async function editTelegramText(
  message: SentMessage,
  text: string,
  buttons?: TelegramButton[],
): Promise<TelegramResult> {
  const config = getTelegramConfig()
  if (!config) return { ok: false, error: 'not_configured' }
  const r = await call(config, 'editMessageText', {
    chat_id: message.chat_id,
    message_id: message.message_id,
    text: truncate(text, MAX_TEXT),
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard(buttons) ?? { inline_keyboard: [] },
  })
  return r.ok ? { ok: true } : { ok: false, error: r.description }
}

/** The small toast Telegram shows after a button tap. */
export async function answerTelegramCallback(callbackId: string, text: string): Promise<void> {
  const config = getTelegramConfig()
  if (!config) return
  await call(config, 'answerCallbackQuery', { callback_query_id: callbackId, text: truncate(text, 200) })
}

let webhookReadyFor: string | null = null

/**
 * Point the bot's updates at this app (button taps only). Idempotent and
 * cached per process; best-effort. NEXT_PUBLIC_SITE_URL must be https.
 */
export async function ensureTelegramWebhook(): Promise<TelegramResult> {
  const config = getTelegramConfig()
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!config) return { ok: false, error: 'not_configured' }
  if (!site || !site.startsWith('https://')) return { ok: false, error: 'NEXT_PUBLIC_SITE_URL must be https' }
  const url = `${site}/api/telegram/webhook`
  if (webhookReadyFor === url) return { ok: true }
  const r = await call(config, 'setWebhook', {
    url,
    secret_token: await telegramWebhookSecret(),
    allowed_updates: ['callback_query'],
  })
  if (r.ok) webhookReadyFor = url
  return r.ok ? { ok: true } : { ok: false, error: r.description }
}
