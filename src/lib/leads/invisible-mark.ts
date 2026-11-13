// ============================================================
// Codes hidden in a WhatsApp text with zero-width characters.
//
// Same encoding as the website (web/simadi/src/public/js/marca-ref.js):
// a two-digit start + three base-4 digits per letter + a checksum digit,
// with U+200B / U+200C / U+200D / U+2060 as the digits 0–3. The start
// says what the code is:
//   * 3 3 — allied-school code (school-ref.ts), at the very end;
//   * 3 2 — website visit code (Meta ads, capi), just before «(vi la web…)».
// Each mark is its own run of invisible characters (visible text sits
// between them), so they never merge.
// ============================================================

export const MARK_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const DIGITS = ['\u200B', '\u200C', '\u200D', '\u2060']
export const INVISIBLE = /[\u200B\u200C\u200D\u2060]+/g
const CODE_RE = new RegExp(`^[${MARK_ALPHABET}]{4,12}$`)

export const MARK_START = {
  school: DIGITS[3] + DIGITS[3],
  visit: DIGITS[3] + DIGITS[2],
} as const

export type MarkKind = keyof typeof MARK_START

function decode(run: string, start: string): string | null {
  if (!run.startsWith(start)) return null
  const digits = [...run.slice(start.length)].map((c) => DIGITS.indexOf(c))
  const check = digits.pop()
  if (digits.length < 12 || digits.length % 3 !== 0) return null
  if (digits.reduce((s, d) => s + d, 0) % 4 !== check) return null
  let code = ''
  for (let i = 0; i < digits.length; i += 3) {
    const n = digits[i] * 16 + digits[i + 1] * 4 + digits[i + 2]
    if (n >= MARK_ALPHABET.length) return null
    code += MARK_ALPHABET[n]
  }
  return CODE_RE.test(code) ? code : null
}

/** The code of that kind hidden in a message, or null (the last one wins). */
export function readMark(text: string | null | undefined, kind: MarkKind): string | null {
  const runs = String(text ?? '').match(INVISIBLE) ?? []
  for (const run of runs.reverse()) {
    const code = decode(run, MARK_START[kind])
    if (code) return code
  }
  return null
}

/** Encode a code as a mark (tests and tools; the website has its own copy). */
export function encodeMark(code: string, kind: MarkKind): string {
  if (!CODE_RE.test(code)) return ''
  const d = [...code].flatMap((c) => {
    const i = MARK_ALPHABET.indexOf(c)
    return [(i >> 4) & 3, (i >> 2) & 3, i & 3]
  })
  return MARK_START[kind] + d.map((x) => DIGITS[x]).join('') + DIGITS[d.reduce((s, x) => s + x, 0) % 4]
}

/** Website visit code («(vi la web…)» links), or null. */
export const readVisitCode = (text: string | null | undefined) => readMark(text, 'visit')
