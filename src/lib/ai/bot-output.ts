// ============================================================
// Post-processing of the model's raw reply.
//
// The account's prompt can ask the model to (a) split its answer into
// several WhatsApp messages and (b) emit machine-readable control lines
// for the automation. Control lines start with `[[` and are NEVER sent to
// the customer — any line starting with `[[`, known or not, is removed.
//
//   [[NUEVO_MENSAJE]]                          → start a new message
//   [[ACCION:PASAR_A_HUMANO|motivo=...]]       → hand off to a human
//   [[ACCION:VERIFICAR_PAGO]]                  → notify: payment to verify
//   [[REGISTRO|nombre=...|correo=...|...]]     → registration data
//   [[ETIQUETA:pago_por_verificar]]            → conversation stage label
//   [[HANDOFF]]                                → built-in handoff sentinel
// ============================================================

export { MESSAGE_SEPARATOR } from './defaults'

/** WhatsApp shows each part as its own bubble; more than this is spam. */
export const MAX_MESSAGES_PER_TURN = 5

export type BotAction =
  | { type: 'handoff'; reason: string | null }
  | { type: 'verify_payment' }
  | { type: 'registro'; fields: Record<string, string> }
  | { type: 'label'; value: string }

export interface BotOutput {
  /** Customer-facing messages, in order, already trimmed and non-empty. */
  messages: string[]
  actions: BotAction[]
}

/** `k=v|k2=v2` → `{ k: 'v', k2: 'v2' }` (keys lower-cased, values trimmed). */
function parseFields(parts: string[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    if (key) fields[key] = part.slice(eq + 1).trim()
  }
  return fields
}

/** Interpret one `[[...]]` control line; null when it carries no action. */
export function parseControlLine(line: string): BotAction | 'separator' | null {
  const inner = line.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim()
  const [head, ...rest] = inner.split('|')
  const [kind, value = ''] = head.split(':').map((s) => s.trim())
  const upperKind = kind.toUpperCase()
  const upperValue = value.toUpperCase()

  if (upperKind === 'NUEVO_MENSAJE') return 'separator'
  if (upperKind === 'HANDOFF') return { type: 'handoff', reason: null }
  if (upperKind === 'ACCION' && upperValue === 'PASAR_A_HUMANO') {
    return { type: 'handoff', reason: parseFields(rest).motivo || null }
  }
  if (upperKind === 'ACCION' && upperValue === 'VERIFICAR_PAGO') {
    return { type: 'verify_payment' }
  }
  if (upperKind === 'REGISTRO') return { type: 'registro', fields: parseFields(rest) }
  if (upperKind === 'ETIQUETA' && value) return { type: 'label', value }
  return null
}

/**
 * Split the raw reply into customer messages + actions. Tags are removed
 * wherever they appear (including the `[[HANDOFF]]` sentinel mid-sentence,
 * matching `parseGeneration`).
 */
export function parseBotOutput(raw: string): BotOutput {
  const actions: BotAction[] = []
  const messages: string[] = []
  let current: string[] = []

  const flush = () => {
    const text = current.join('\n').trim()
    if (text) messages.push(text)
    current = []
  }

  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (line.trim().startsWith('[[') && !/\[\[[^\]]*\]\]/.test(line)) {
      // An unterminated control line: never show it, nothing to parse.
      continue
    }
    // Tags are meant to sit on their own line, but a model sometimes
    // appends one to a sentence — strip them wherever they appear.
    const pieces = line.split(/(\[\[[^\]]*\]\])/)
    let text = ''
    let sawTag = false
    for (const piece of pieces) {
      if (!piece.startsWith('[[')) {
        text += piece
        continue
      }
      sawTag = true
      const parsed = parseControlLine(piece)
      if (parsed === 'separator') {
        if (text.trim()) current.push(text)
        text = ''
        flush()
      } else if (parsed) {
        actions.push(parsed)
      }
    }
    // A line that held only tags leaves no blank line behind.
    if (sawTag && !text.trim()) continue
    current.push(sawTag ? text.trimEnd() : text)
  }
  flush()

  // Keep the order but cap the count: overflow is folded into the last
  // allowed message rather than dropped.
  if (messages.length > MAX_MESSAGES_PER_TURN) {
    const head = messages.slice(0, MAX_MESSAGES_PER_TURN - 1)
    const tail = messages.slice(MAX_MESSAGES_PER_TURN - 1).join('\n\n')
    return { messages: [...head, tail], actions }
  }
  return { messages, actions }
}

export function hasAction<T extends BotAction['type']>(
  actions: BotAction[],
  type: T,
): Extract<BotAction, { type: T }> | undefined {
  return actions.find((a): a is Extract<BotAction, { type: T }> => a.type === type)
}
