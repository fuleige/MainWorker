'use client';

import { type ComponentProps, type MouseEvent, useEffect, useRef } from 'react';
import { codeTextFromRenderedLines } from '@/lib/code-copy';

function codeText(code: Element) {
  const lines = Array.from(code.children).filter((child) => child.classList.contains('code-line'));
  if (lines.length) return codeTextFromRenderedLines(lines.map((line) => line.textContent || ''));
  return (code.textContent || '').replaceAll('\u200b', '');
}

async function writeClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based fallback for older iOS browsers.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;inset:0 auto auto 0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- Required as a fallback for older iOS WebKit versions without the Clipboard API.
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function setButtonResult(button: HTMLButtonElement, copied: boolean, timers: Set<number>) {
  button.textContent = copied ? '已复制' : '复制失败';
  button.dataset.copyState = copied ? 'success' : 'error';
  const timer = window.setTimeout(() => {
    button.textContent = '复制';
    delete button.dataset.copyState;
    timers.delete(timer);
  }, 1_600);
  timers.add(timer);
}

export function CopyablePre({ language, children, ...props }: ComponentProps<'pre'> & { language?: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimers = useRef(new Set<number>());

  useEffect(() => () => {
    resetTimers.current.forEach((timer) => window.clearTimeout(timer));
    resetTimers.current.clear();
  }, []);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    const code = preRef.current?.querySelector('code');
    if (!code) return;
    setButtonResult(button, await writeClipboard(codeText(code)), resetTimers.current);
  }

  return (
    <div className="code-block">
      <div className="code-block-toolbar"><span>{language || '代码'}</span><button type="button" className="code-copy-button" onClick={(event) => void copy(event)}>复制</button></div>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  );
}

export function StaticMarkdown({ className, html }: { className: string; html: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const resetTimers = useRef(new Set<number>());

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handleCopy = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button[data-copy-code]');
      if (!button || !root.contains(button)) return;
      const code = button.closest('.code-block')?.querySelector('pre code');
      if (!code) return;
      void writeClipboard(codeText(code)).then((copied) => {
        if (button.isConnected) setButtonResult(button, copied, resetTimers.current);
      });
    };
    root.addEventListener('click', handleCopy);
    return () => root.removeEventListener('click', handleCopy);
  }, [html]);

  useEffect(() => () => {
    resetTimers.current.forEach((timer) => window.clearTimeout(timer));
    resetTimers.current.clear();
  }, []);

  return <div ref={rootRef} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
