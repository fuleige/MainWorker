'use client';

import { Children, type ComponentProps, isValidElement, useDeferredValue } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CopyablePre } from '@/components/copyable-code';
import { escapeCodeHtml, normalizeCodeLanguage, withCodeLineMarkup } from '@/lib/code-highlight';
import { normalizeMathDelimiters } from '@/lib/markdown-math';

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

function stabilizeOpenCodeFence(source: string) {
  let openFence: { marker: string; length: number } | null = null;
  for (const line of source.split('\n')) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    const marker = match[1][0];
    const length = match[1].length;
    if (!openFence) openFence = { marker, length };
    else if (marker === openFence.marker && length >= openFence.length) openFence = null;
  }
  if (!openFence) return source;
  return `${source}${source.endsWith('\n') ? '' : '\n'}${openFence.marker.repeat(openFence.length)}`;
}

type StreamingCodeProps = ComponentProps<'code'> & { node?: unknown };

function StreamingCode({ node: _node, className, children, ...props }: StreamingCodeProps) {
  const raw = typeof children === 'string' ? children : typeof children === 'number' ? String(children) : '';
  const languageMatch = /language-([^\s]+)/.exec(className || '');
  const isBlock = Boolean(languageMatch) || raw.includes('\n');
  if (!isBlock) return <code className={className} {...props}>{children}</code>;

  const source = raw.replace(/\n$/, '');
  const language = normalizeCodeLanguage(languageMatch?.[1]);
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : escapeCodeHtml(source);
  const codeClassName = ['hljs', 'code-lines', language ? `language-${language}` : ''].filter(Boolean).join(' ');

  return <code className={codeClassName} data-language={language || undefined} {...props} dangerouslySetInnerHTML={{ __html: withCodeLineMarkup(highlighted) }} />;
}

type StreamingPreProps = ComponentProps<'pre'> & { node?: unknown };

function StreamingPre({ node: _node, children, ...props }: StreamingPreProps) {
  const code = Children.toArray(children).find((child) => isValidElement(child));
  const className = isValidElement<{ className?: string }>(code) ? code.props.className : '';
  const language = normalizeCodeLanguage(/language-([^\s]+)/.exec(className || '')?.[1]);
  return <CopyablePre language={language} {...props}>{children}</CopyablePre>;
}

export function StreamingMarkdown({ source }: { source: string }) {
  const deferredSource = useDeferredValue(source);
  return (
    <ReactMarkdown components={{ code: StreamingCode, pre: StreamingPre }} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml>
      {stabilizeOpenCodeFence(normalizeMathDelimiters(deferredSource))}
    </ReactMarkdown>
  );
}
