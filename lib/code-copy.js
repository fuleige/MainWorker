export function codeTextFromRenderedLines(lines) {
  return Array.from(lines, (line) => String(line || '').replaceAll('\u200b', '')).join('\n');
}
