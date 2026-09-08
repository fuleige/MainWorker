'use client';

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { BookOpenText, CalendarDays, type LucideIcon } from 'lucide-react';

type ToolModuleProps = { onUnauthorized: () => void };

type WorkbenchToolDefinition = {
  id: string;
  title: string;
  description: string;
  href: `/tools/${string}`;
  documentTitle: string;
  legacyModule?: string;
  icon: LucideIcon;
  tone: string;
  component: LazyExoticComponent<ComponentType<ToolModuleProps>>;
};

export const workbenchTools = [
  {
    id: 'articles',
    title: '文章',
    description: '浏览本机 Markdown 文章，并在独立上下文中审核和修改。',
    href: '/tools/articles',
    documentTitle: '文章审核 · MainWorker',
    legacyModule: 'articles',
    icon: BookOpenText,
    tone: 'blue',
    component: lazy(async () => ({ default: (await import('@/components/articles-module')).ArticlesModule })),
  },
  {
    id: 'planner',
    title: '规划',
    description: '管理项目、今日事项和循环任务。',
    href: '/tools/planner',
    documentTitle: '个人规划 · MainWorker',
    legacyModule: 'planner',
    icon: CalendarDays,
    tone: 'cyan',
    component: lazy(async () => ({ default: (await import('@/components/planner-module')).PlannerModule })),
  },
] as const satisfies readonly WorkbenchToolDefinition[];

export type WorkbenchToolId = (typeof workbenchTools)[number]['id'];

export function workbenchToolById(id: WorkbenchToolId) {
  return workbenchTools.find((tool) => tool.id === id);
}

export function workbenchToolByPath(pathname: string) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return workbenchTools.find((tool) => tool.href === path);
}

export function workbenchToolByLegacyModule(module: string | null) {
  return module ? workbenchTools.find((tool) => tool.legacyModule === module) : undefined;
}
