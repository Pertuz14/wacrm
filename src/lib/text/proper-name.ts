// ============================================================
// A person's name with capital initials, as it should read in
// Telegram and in the platform: «andrea gonzález» → «Andrea González»,
// «MARÍA JOSÉ DE LA ROSA» → «María José de la Rosa». Particles (de,
// del, la, las, los, y) stay lowercase except at the start; hyphenated
// and apostrophe parts are capitalized too («ana-maría», «d'angelo»).
// ============================================================

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'dos', 'van', 'von'])

const capitalize = (w: string) => (w ? w.charAt(0).toLocaleUpperCase('es') + w.slice(1) : w)

export function properName(name: string | null | undefined): string {
  const words = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es')
    .split(' ')
    .filter(Boolean)
  return words
    .map((word, i) => {
      if (i > 0 && PARTICLES.has(word)) return word
      return word.split(/([-'’])/).map((part) => (/^[-'’]$/.test(part) ? part : capitalize(part))).join('')
    })
    .join(' ')
}
