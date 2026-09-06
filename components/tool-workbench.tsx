'use client';

import { ArrowUpRight, BookOpenText, CalendarDays } from 'lucide-react';

const tools = [
  {
    title: '文章',
    description: '浏览本机 Markdown 文章，并在独立上下文中审核和修改。',
    href: '/tools/articles',
    icon: BookOpenText,
    tone: 'blue',
  },
  {
    title: '规划',
    description: '整理长期方向、今日事项和层级任务。',
    href: '/tools/planner',
    icon: CalendarDays,
    tone: 'cyan',
  },
];

export function ToolWorkbench() {
  return (
    <section className="tool-workbench">
      <header className="tool-workbench-header">
        <div><p className="overline">TOOLS</p><h1>工作台</h1><p>选择一个工具后会在新的浏览器标签页中打开；工具地址可以直接收藏。</p></div>
      </header>
      <div className="tool-grid">
        {tools.map((tool) => (
          <a className={`tool-card is-${tool.tone}`} href={tool.href} target="_blank" rel="noopener noreferrer" key={tool.href}>
            <span className="tool-card-icon"><tool.icon /></span>
            <span className="tool-card-copy"><strong>{tool.title}</strong><small>{tool.description}</small></span>
            <span className="tool-card-open"><ArrowUpRight /><span>新标签页</span></span>
          </a>
        ))}
      </div>
    </section>
  );
}
