import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'MainWorker · 个人工作台',
  description: '基于 Codex App Server 的个人工作台',
};

const iosChromeRestorationStyle = `
html[data-ios-chrome-restoring="true"] { background: #f4f8fe; }
html[data-ios-chrome-restoring="true"] body { opacity: 0 !important; }
html[data-ios-chrome-restoring="true"]::after {
  content: "正在恢复页面…";
  position: fixed;
  z-index: 2147483647;
  inset: 0;
  display: grid;
  place-items: center;
  background: #f4f8fe;
  color: #60758f;
  font: 600 14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
  letter-spacing: .04em;
}
`;

const iosChromeRestorationBootstrap = `
(() => {
  try {
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!ios || !/CriOS\\//.test(ua)) return;
    history.scrollRestoration = 'manual';
    const entry = performance.getEntriesByType('navigation')[0];
    const backForward = entry?.type === 'back_forward' || performance.navigation?.type === 2;
    if (!backForward) return;
    const guardKey = 'mainworker:ios-chrome-restoration-reload-guard';
    const now = Date.now();
    const lastAttemptAt = Number(localStorage.getItem(guardKey)) || 0;
    if (lastAttemptAt > 0 && now - lastAttemptAt < 5000) return;
    document.documentElement.dataset.iosChromeRestoring = 'true';
    localStorage.setItem(guardKey, String(now));
    localStorage.setItem('mainworker:ios-chrome-restoration-last-reload-at', String(now));
    const countKey = 'mainworker:ios-chrome-restoration-reload-count';
    localStorage.setItem(countKey, String((Number(localStorage.getItem(countKey)) || 0) + 1));
    setTimeout(() => location.reload(), 120);
    setTimeout(() => document.documentElement.removeAttribute('data-ios-chrome-restoring'), 4000);
  } catch {
    document.documentElement.removeAttribute('data-ios-chrome-restoring');
  }
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: iosChromeRestorationStyle }} />
        <script dangerouslySetInnerHTML={{ __html: iosChromeRestorationBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
