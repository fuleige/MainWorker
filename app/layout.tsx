import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'MainWorker · 个人工作台',
  description: '基于 Codex App Server 的个人工作台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
