/** Required words apply only to the sender's own group-message text. */
export function requiredGroupKeyword(kind, text, keywords) {
  if (kind !== 'group' || !Array.isArray(keywords)) return '';
  const content = String(text ?? '').toLocaleLowerCase();
  return keywords.map((word) => String(word ?? '').trim()).find((word) => word && content.includes(word.toLocaleLowerCase())) || '';
}
