/** Convert an HTML-only email into safe, readable plain text.
 *
 * Email bodies are untrusted input, so they must not be interpolated into
 * the dashboard DOM. This deliberately preserves useful structure while
 * dropping markup, styling, scripts, and tracking elements.
 */
export function htmlToPlainText(html: string): string {
  const withStructure = html
    .replace(/<(script|style|head|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|section|article|blockquote|tr|table)\s*>/gi, '\n\n')
    .replace(/<td\b[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')

  return decodeHtmlEntities(withStructure)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Normalize rows synced before HTML-only bodies were converted at ingest. */
export function normalizeStoredEmailBody(body: string): string {
  return looksLikeHtml(body)
    ? htmlToPlainText(body)
    : body
}

export function looksLikeHtml(body: string): boolean {
  return /<(?:html|body|head|style|script|div|p|br|table|tr|td|h[1-6]|ul|ol|li|span|a)\b[^>]*>/i.test(body)
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity
    const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10
    const digits = radix === 16 ? code.slice(2) : code.slice(1)
    const point = Number.parseInt(digits, radix)
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity
  })
}
