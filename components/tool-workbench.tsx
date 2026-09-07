'use client';

import { ArrowUpRight } from 'lucide-react';
import { workbenchTools } from '@/components/workbench-tools';

export function ToolWorkbench() {
  return (
    <section className="tool-workbench">
      <header className="tool-workbench-header">
        <div><p className="overline">TOOLS</p><h1>工作台</h1><p>选择一个工具后会在新的浏览器标签页中打开；工具地址可以直接收藏。</p></div>
      </header>
      <div className="tool-grid">
        {workbenchTools.map((tool) => (
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
