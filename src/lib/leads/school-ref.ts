import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Allied-school link (Rumbo a la U, plan v9 phase 4).
//
// A school shares rumbouni.com/?r=<code>. The website keeps the code for
// 30 days and appends it, written with zero-width characters, to the end
// of the pre-filled WhatsApp text ("…(vi la web)" + invisible mark). The
// family sees the usual message; we read the code here.
//
// Same encoding as the platform (web/simadi/src/public/js/marca-ref.js):
// start (3 3) + three base-4 digits per letter + a checksum digit, with
// U+200B / U+200C / U+200D / U+2060 as the digits 0–3.
// ============================================================

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const DIGITS = ['​', '‌', '‍', '⁠']
const START = DIGITS[3] + DIGITS[3]
const INVISIBLE = /[​‌‍⁠]+/g
const CODE_RE = new RegExp(`^[${ALPHABET}]{4,12}$`)

function decode(run: string): string | null {
  if (!run.startsWith(START)) return null
  const digits = [...run.slice(START.length)].map((c) => DIGITS.indexOf(c))
  const check = digits.pop()
  if (digits.length < 12 || digits.length % 3 !== 0) return null
  if (digits.reduce((s, d) => s + d, 0) % 4 !== check) return null
  let code = ''
  for (let i = 0; i < digits.length; i += 3) {
    const n = digits[i] * 16 + digits[i + 1] * 4 + digits[i + 2]
    if (n >= ALPHABET.length) return null
    code += ALPHABET[n]
  }
  return CODE_RE.test(code) ? code : null
}

/** The allied-school code hidden in a message, or null (the last one wins). */
export function readSchoolRef(text: string | null | undefined): string | null {
  const runs = String(text ?? '').match(INVISIBLE) ?? []
  for (const run of runs.reverse()) {
    const code = decode(run)
    if (code) return code
  }
  return null
}

/** The message without the invisible mark (what people and the model see). */
export function stripSchoolRef(text: string): string
export function stripSchoolRef(text: string | null | undefined): string | null | undefined
export function stripSchoolRef(text: string | null | undefined) {
  return typeof text === 'string' ? text.replace(INVISIBLE, '') : text
}

/**
 * Internal line for the bot (business prompt, section «Colegios aliados»):
 * it asks year and section only to these customers, when they fill in the
 * REGISTRO, and never mentions it.
 */
export const schoolRefContext = (code: string) =>
  `[Contexto interno: llegó por el enlace de un colegio aliado · código ${code}]`

/** Contact note in the CRM (only the team sees it). */
export const schoolRefNote = (code: string) => `🏫 Llegó por el enlace de un colegio aliado (código ${code})`

/**
 * Allied-school code of a conversation: the mark travels in one of the
 * customer's first messages, which may already be out of the model's
 * recent-history window — so it is looked up on its own. Never throws.
 */
export async function conversationSchoolRef(db: SupabaseClient, conversationId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: true })
      .limit(5)
    if (error) return null
    for (const m of (data ?? []) as { content_text: string | null }[]) {
      const code = readSchoolRef(m.content_text)
      if (code) return code
    }
    return null
  } catch {
    return null
  }
}
