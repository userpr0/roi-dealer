/*
 * Plain text from the small HTML subset sources such as Hacker News use in item texts:
 * paragraphs, line breaks, links, emphasis, code and character references.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (reference, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : reference;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? reference;
  });
}

export function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<\s*p\s*\/?>/gi, '\n\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(withoutTags)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
