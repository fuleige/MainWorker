const LANGUAGE_ALIASES = new Map([
  ['c++', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'],
  ['py', 'python'],
  ['yml', 'yaml'],
  ['js', 'javascript'], ['jsx', 'javascript'],
  ['ts', 'typescript'], ['tsx', 'typescript'],
  ['sh', 'bash'], ['shell', 'bash'], ['shellscript', 'bash'], ['shell-script', 'bash'], ['zsh', 'bash'],
  ['html', 'xml'], ['vue', 'xml'],
  ['md', 'markdown'],
  ['jsonc', 'json'],
]);

export function normalizeCodeLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase().replace(/^language-/, '');
  return LANGUAGE_ALIASES.get(normalized) || normalized;
}

export function escapeCodeHtml(source) {
  return String(source || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function withCodeLineMarkup(highlighted) {
  const lines = [''];
  const openSpans = [];
  const tokens = String(highlighted || '').split(/(<span\b[^>]*>|<\/span>|\n)/g);

  for (const token of tokens) {
    if (!token) continue;
    if (token === '\n') {
      lines[lines.length - 1] += '</span>'.repeat(openSpans.length);
      lines.push(openSpans.join(''));
    } else if (/^<span\b/.test(token)) {
      openSpans.push(token);
      lines[lines.length - 1] += token;
    } else if (token === '</span>') {
      openSpans.pop();
      lines[lines.length - 1] += token;
    } else {
      lines[lines.length - 1] += token;
    }
  }

  return lines.map((line) => `<span class="code-line">${line || '&#8203;'}</span>`).join('');
}
