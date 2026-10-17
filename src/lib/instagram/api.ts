// ============================================================
// Instagram Messaging API (Instagram API with Instagram Login).
//
// Thin wrappers over graph.instagram.com. Every call takes the
// decrypted access token of the connected Instagram professional
// account (see ./config). Errors are raised as `InstagramApiError`
// with Meta's code/message so callers can explain them.
// ============================================================

export const INSTAGRAM_GRAPH = 'https://graph.instagram.com/v25.0'

/** Webhook fields the CRM subscribes the account to. */
export const WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_reactions',
  'messaging_seen',
  'comments',
] as const

export class InstagramApiError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  readonly status: number
  constructor(message: string, status: number, code: number | null = null, subcode: number | null = null) {
    super(message)
    this.name = 'InstagramApiError'
    this.status = status
    this.code = code
    this.subcode = subcode
  }
}

type Fetcher = typeof fetch

interface CallArgs {
  token: string
  method?: 'GET' | 'POST' | 'DELETE'
  params?: Record<string, string>
  body?: unknown
  fetcher?: Fetcher
}

/** One Graph call. The token travels in the Authorization header, never in the URL. */
export async function igCall<T = Record<string, unknown>>(path: string, args: CallArgs): Promise<T> {
  const { token, method = 'GET', params, body, fetcher = fetch } = args
  const url = new URL(`${INSTAGRAM_GRAPH}${path.startsWith('/') ? path : `/${path}`}`)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  const res = await fetcher(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number }
  } & T
  if (!res.ok || json.error) {
    const e = json.error ?? {}
    throw new InstagramApiError(
      e.message || `Instagram API ${res.status}`,
      res.status,
      e.code ?? null,
      e.error_subcode ?? null,
    )
  }
  return json
}

/** The connected professional account. `user_id` is the id webhooks carry as `entry.id`. */
export async function getMe(token: string, fetcher?: Fetcher) {
  return igCall<{ id: string; user_id?: string; username?: string; name?: string }>('/me', {
    token,
    params: { fields: 'id,user_id,username,name' },
    fetcher,
  })
}

/** Long-lived tokens last 60 days; refreshing returns a fresh 60-day token. */
export async function refreshToken(token: string, fetcher: Fetcher = fetch) {
  const url = new URL('https://graph.instagram.com/refresh_access_token')
  url.searchParams.set('grant_type', 'ig_refresh_token')
  url.searchParams.set('access_token', token)
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) })
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: { message?: string; code?: number }
  }
  if (!res.ok || !json.access_token) {
    throw new InstagramApiError(json.error?.message || `refresh failed (${res.status})`, res.status, json.error?.code ?? null)
  }
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? null }
}

/** Turns on webhook delivery for the connected account (the "Webhook subscription" switch in Meta). */
export async function subscribeToWebhooks(token: string, fetcher?: Fetcher) {
  return igCall<{ success?: boolean }>('/me/subscribed_apps', {
    token,
    method: 'POST',
    params: { subscribed_fields: WEBHOOK_FIELDS.join(',') },
    fetcher,
  })
}

export interface SendResult {
  messageId: string
  recipientId: string | null
}

async function sendMessage(token: string, payload: Record<string, unknown>, fetcher?: Fetcher): Promise<SendResult> {
  const r = await igCall<{ message_id?: string; recipient_id?: string }>('/me/messages', {
    token,
    method: 'POST',
    body: payload,
    fetcher,
  })
  if (!r.message_id) throw new InstagramApiError('Instagram did not return a message id', 502)
  return { messageId: r.message_id, recipientId: r.recipient_id ?? null }
}

/** Instagram caps a text message at 1000 characters. */
export const INSTAGRAM_TEXT_MAX = 1000

export function sendText(args: { token: string; recipientId: string; text: string; replyToMid?: string; fetcher?: Fetcher }) {
  return sendMessage(
    args.token,
    {
      recipient: { id: args.recipientId },
      message: { text: args.text },
      ...(args.replyToMid ? { reply_to: { mid: args.replyToMid } } : {}),
    },
    args.fetcher,
  )
}

export type InstagramMediaKind = 'image' | 'video' | 'audio'

export function sendMedia(args: { token: string; recipientId: string; kind: InstagramMediaKind; url: string; fetcher?: Fetcher }) {
  return sendMessage(
    args.token,
    { recipient: { id: args.recipientId }, message: { attachment: { type: args.kind, payload: { url: args.url } } } },
    args.fetcher,
  )
}

/** Private reply to a comment: opens a DM with whoever commented (allowed up to 7 days after the comment). */
export function sendPrivateReply(args: { token: string; commentId: string; text: string; fetcher?: Fetcher }) {
  return sendMessage(args.token, { recipient: { comment_id: args.commentId }, message: { text: args.text } }, args.fetcher)
}

/** Public reply under a comment. */
export async function replyToComment(args: { token: string; commentId: string; text: string; fetcher?: Fetcher }) {
  return igCall<{ id?: string }>(`/${encodeURIComponent(args.commentId)}/replies`, {
    token: args.token,
    method: 'POST',
    params: { message: args.text },
    fetcher: args.fetcher,
  })
}

/** "typing…" / "seen" in the customer's chat. Cosmetic; callers swallow failures. */
export async function senderAction(args: { token: string; recipientId: string; action: 'typing_on' | 'typing_off' | 'mark_seen'; fetcher?: Fetcher }) {
  return igCall('/me/messages', {
    token: args.token,
    method: 'POST',
    body: { recipient: { id: args.recipientId }, sender_action: args.action },
    fetcher: args.fetcher,
  })
}

/** Name / username of someone who messaged the account (User Profile API). */
export async function getUserProfile(args: { token: string; igsid: string; fetcher?: Fetcher }) {
  return igCall<{ name?: string; username?: string; profile_pic?: string }>(`/${encodeURIComponent(args.igsid)}`, {
    token: args.token,
    params: { fields: 'name,username,profile_pic' },
    fetcher: args.fetcher,
  })
}
