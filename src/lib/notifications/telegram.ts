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
