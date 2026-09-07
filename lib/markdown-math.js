function replaceMathDelimiters(line) {
  let result = '';
  let codeTicks = 0;

  for (let index = 0; index < line.length;) {
    if (line[index] === '`') {
      let end = index + 1;
      while (line[end] === '`') end += 1;
      const tickCount = end - index;
      if (codeTicks === 0) codeTicks = tickCount;
      else if (tickCount === codeTicks) codeTicks = 0;
      result += line.slice(index, end);
      index = end;
      continue;
    }

    const delimiter = line.slice(index, index + 2);
    const isMathDelimiter = codeTicks === 0 && ['\\(', '\\)', '\\[', '\\]'].includes(delimiter);
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) precedingBackslashes += 1;
    if (isMathDelimiter && precedingBackslashes % 2 === 0) {
      result += delimiter === '\\(' || delimiter === '\\)' ? '$' : '$$';
      index += 2;
      continue;
    }

    result += line[index];
    index += 1;
  }

  return result;
}

export function normalizeMathDelimiters(source) {
  let openFence = null;
  return String(source || '').split('\n').map((line) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      if (!openFence) openFence = { marker, length };
      else if (marker === openFence.marker && length >= openFence.length) openFence = null;
      return line;
    }
    return openFence ? line : replaceMathDelimiters(line);
  }).join('\n');
}
