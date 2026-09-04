import fs from 'node:fs/promises';
import path from 'node:path';
import hljs from 'highlight.js';
import katexExtension from 'marked-katex-extension';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import sanitizeHtml from 'sanitize-html';
import { normalizeCodeLanguage, withCodeLineMarkup } from '../lib/code-highlight.js';

const syntaxHighlight = markedHighlight({
  emptyLangClass: 'hljs',
  langPrefix: 'hljs language-',
  highlight(code, language) {
    const normalized = normalizeCodeLanguage(language);
    const highlighted = normalized && hljs.getLanguage(normalized)
      ? hljs.highlight(code, { language: normalized }).value
      : hljs.highlightAuto(code).value;
    return withCodeLineMarkup(highlighted);
  },
});

const markdown = new Marked(
  katexExtension({ throwOnError: false, nonStandard: true }),
  syntaxHighlight,
  {
    renderer: {
      heading(token) {
        const id = token.headingId || 'section';
        return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
    },
  },
);

const EXTRA_TAGS = [
  'article', 'section', 'figure', 'figcaption', 'img', 'input', 'svg', 'path', 'u', 's', 'mark',
  'math', 'annotation', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms',
  'mtext', 'mspace', 'mstyle', 'msup', 'msub', 'msubsup', 'mfrac', 'mroot', 'msqrt',
  'mtable', 'mtr', 'mtd', 'mover', 'munder', 'munderover', 'mpadded',
  'mphantom', 'menclose',
];

const KATEX_EM_LENGTH = [/^-?(?:\d{1,3}(?:\.\d{1,6})?|\.\d{1,6})em$/];
const KATEX_POSITIVE_EM_LENGTH = [/^(?:\d{1,3}(?:\.\d{1,6})?|\.\d{1,6})em$/];
const KATEX_SPAN_STYLES = {
  color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/],
  position: [/^relative$/],
  top: KATEX_EM_LENGTH,
  bottom: KATEX_EM_LENGTH,
  left: KATEX_EM_LENGTH,
  'vertical-align': KATEX_EM_LENGTH,
  height: KATEX_POSITIVE_EM_LENGTH,
  width: KATEX_POSITIVE_EM_LENGTH,
  'min-width': KATEX_POSITIVE_EM_LENGTH,
  'margin-left': KATEX_EM_LENGTH,
  'margin-right': KATEX_EM_LENGTH,
  'padding-left': KATEX_POSITIVE_EM_LENGTH,
  'border-style': [/^(?:solid|dashed)$/],
  'border-width': KATEX_POSITIVE_EM_LENGTH,
  'border-top-width': KATEX_POSITIVE_EM_LENGTH,
  'border-right-width': KATEX_POSITIVE_EM_LENGTH,
  'border-bottom-width': KATEX_POSITIVE_EM_LENGTH,
};

function headingSlug(value, counts) {
  const base = String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s+/g, '-') || 'section';
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

function splitLocalHref(href) {
  const index = href.indexOf('#');
  if (index < 0) return { pathname: href, fragment: '' };
  return { pathname: href.slice(0, index), fragment: href.slice(index + 1) };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveContentReference(projectRoot, articlePath, href, sourceId = '') {
  if (!href || /^(?:[a-z]+:|#|\/\/)/i.test(href)) return href;
  const target = path.resolve(path.dirname(path.resolve(projectRoot, articlePath)), decodeURIComponent(href));
  if (!isInside(projectRoot, target)) return '';
  const relative = path.relative(projectRoot, target).split(path.sep).map(encodeURIComponent);
  const prefix = sourceId ? `${encodeURIComponent(sourceId)}/` : '';
  return `/content/${prefix}${relative.join('/')}`;
}

export async function renderMarkdown(projectRoot, articlePath, source, sourceId = '') {
  const headingCounts = new Map();
  const html = await markdown.parse(String(source || ''), {
    async: true,
    walkTokens(token) {
      void syntaxHighlight.walkTokens(token);
      if (token.type === 'heading') token.headingId = headingSlug(token.text, headingCounts);
      if (token.type === 'image') token.href = resolveContentReference(projectRoot, articlePath, token.href, sourceId);
      if (token.type === 'link' && !/^(?:[a-z]+:|#|\/\/)/i.test(token.href || '')) {
        const { pathname, fragment } = splitLocalHref(token.href || '');
        const resolved = path.resolve(path.dirname(path.resolve(projectRoot, articlePath)), decodeURIComponent(pathname));
        if (isInside(projectRoot, resolved) && resolved.toLowerCase().endsWith('.md')) {
          const relative = path.relative(projectRoot, resolved).split(path.sep).join('/');
          const sourceParam = sourceId ? `&source=${encodeURIComponent(sourceId)}` : '';
          const hash = fragment ? `#${fragment}` : '';
          token.href = `/?module=articles${sourceParam}&article=${encodeURIComponent(relative)}${hash}`;
        }
      }
    },
  });

  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, ...EXTRA_TAGS],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': ['class', 'id', 'aria-hidden'],
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      input: ['type', 'checked', 'disabled'],
      svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio'],
      path: ['d'],
      annotation: ['encoding'], math: ['xmlns', 'display'],
      mfrac: ['linethickness'], mi: ['mathvariant'],
      mo: ['fence', 'lspace', 'mathvariant', 'rspace', 'separator', 'stretchy'],
      mover: ['accent'], mpadded: ['height', 'voffset', 'width'],
      mspace: ['height', 'mathbackground', 'width'],
      mstyle: ['displaystyle', 'scriptlevel'],
      mtable: ['center', 'columnalign', 'columnspacing', 'rowspacing'],
      span: ['class', 'style', 'aria-hidden'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedStyles: { span: KATEX_SPAN_STYLES },
    parser: { lowerCaseAttributeNames: false },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
      img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }, true),
      input(_tagName, attribs) {
        return {
          tagName: 'input',
          attribs: {
            type: 'checkbox',
            disabled: '',
            ...(Object.hasOwn(attribs, 'checked') ? { checked: '' } : {}),
          },
        };
      },
    },
  });
}

function titleFromMarkdown(source, fallback) {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function withoutPrimaryHeading(source) {
  return String(source || '').replace(/^#\s+.+(?:\r?\n|$)/m, '').trimStart();
}

function excerptFromMarkdown(source) {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[$#>*_`~\\{}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const IGNORED_DIRECTORIES = new Set(['node_modules', 'web', 'draft', 'drafts', 'template', 'templates']);
const IGNORED_FILES = new Set(['readme.md']);

function normalizeRelative(value, label) {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} 必须是安全的相对路径`);
  }
  return normalized;
}

function isUnder(relative, directory) {
  return relative === directory || relative.startsWith(`${directory}/`);
}

function isExplicitlyExcluded(source) {
  const frontmatter = String(source || '').slice(0, 8192).match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/);
  return Boolean(frontmatter && /^mainworker:\s*(?:false|ignore|exclude)\s*$/im.test(frontmatter[1]));
}

async function listMarkdownFiles(root, relativeRoot, shouldSkip) {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(relativeRoot, entry.name);
    const portable = relative.split(path.sep).join('/');
    if (shouldSkip(portable, entry)) return [];
    if (entry.isDirectory()) return listMarkdownFiles(root, relative, shouldSkip);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return [portable];
    return [];
  }));
  return nested.flat();
}

export class ContentRepository {
  constructor(sourceDefinitions) {
    if (!Array.isArray(sourceDefinitions) || !sourceDefinitions.length) throw new Error('至少需要配置一个文章来源');
    const ids = new Set();
    this.sources = sourceDefinitions.map((definition, index) => {
      const id = String(definition.id || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`文章来源 ${index + 1} 的 id 无效`);
      if (ids.has(id)) throw new Error(`文章来源 id 重复：${id}`);
      ids.add(id);
      const root = path.resolve(String(definition.root || ''));
      const articleDirectories = (definition.articleDirectories || ['articles']).map((directory) => normalizeRelative(directory, `文章来源 ${id} 的 articleDirectories`));
      const exclude = (definition.exclude || []).map((entry) => normalizeRelative(entry, `文章来源 ${id} 的 exclude`));
      return {
        id,
        name: String(definition.name || id).trim() || id,
        root,
        articleDirectories,
        includeRootMarkdown: definition.includeRootMarkdown === true,
        includeReadme: definition.includeReadme === true,
        exclude,
      };
    });
    this.sourceMap = new Map(this.sources.map((source) => [source.id, source]));
    this.defaultSource = this.sources[0];
  }

  listSources() {
    return this.sources.map((source) => ({
      id: source.id,
      name: source.name,
      articleDirectories: source.articleDirectories,
      includeRootMarkdown: source.includeRootMarkdown,
      includeReadme: source.includeReadme,
    }));
  }

  resolveSource(sourceId) {
    const id = String(sourceId || this.defaultSource.id).trim().toLowerCase();
    const source = this.sourceMap.get(id);
    if (!source) throw new Error('文章来源不存在');
    return source;
  }

  articleKey(sourceId, articlePath) {
    const source = this.resolveSource(sourceId);
    return source === this.defaultSource ? articlePath : `${source.id}:${articlePath}`;
  }

  isExcludedPath(source, relative, entry = null) {
    const parts = relative.split('/');
    const name = parts.at(-1) || '';
    if (name.startsWith('.') || name.startsWith('_')) return true;
    if (entry?.isDirectory?.() && IGNORED_DIRECTORIES.has(name.toLowerCase())) return true;
    if (entry?.isFile?.() && IGNORED_FILES.has(name.toLowerCase()) && !(source.includeReadme && name.toLowerCase() === 'readme.md')) return true;
    if (parts.slice(0, -1).some((part) => part.startsWith('.') || part.startsWith('_') || IGNORED_DIRECTORIES.has(part.toLowerCase()))) return true;
    return source.exclude.some((excluded) => isUnder(relative, excluded));
  }

  isArticlePath(source, relative) {
    if (!relative.toLowerCase().endsWith('.md') || this.isExcludedPath(source, relative, { isFile: () => true })) return false;
    if (source.includeRootMarkdown && !relative.includes('/')) return true;
    return source.articleDirectories.some((directory) => isUnder(relative, directory));
  }

  resolveArticle(sourceId, articlePath) {
    const source = this.resolveSource(sourceId);
    if (!articlePath || articlePath.includes('\0')) throw new Error('文章路径无效');
    const absolute = path.resolve(source.root, articlePath.split('/').join(path.sep));
    if (!isInside(source.root, absolute) || !absolute.toLowerCase().endsWith('.md')) throw new Error('文章路径不在内容目录中');
    const relative = path.relative(source.root, absolute).split(path.sep).join('/');
    if (!this.isArticlePath(source, relative)) throw new Error('该 Markdown 文件不符合文章收录规范');
    return { absolute, relative, source, key: this.articleKey(source.id, relative) };
  }

  resolveAsset(sourceId, assetPath) {
    const source = this.resolveSource(sourceId);
    const absolute = path.resolve(source.root, assetPath.split('/').join(path.sep));
    if (!isInside(source.root, absolute)) throw new Error('资源路径无效');
    const relative = path.relative(source.root, absolute).split(path.sep).join('/');
    const allowed = isUnder(relative, 'assets') || source.articleDirectories.some((directory) => isUnder(relative, directory));
    if (!allowed || this.isExcludedPath(source, relative)) throw new Error('资源路径无效');
    return absolute;
  }

  async listSourceArticles(source) {
    const candidates = [];
    if (source.includeRootMarkdown) {
      let entries = [];
      try {
        entries = await fs.readdir(source.root, { withFileTypes: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const entry of entries) {
        if (entry.isFile() && this.isArticlePath(source, entry.name)) candidates.push(entry.name);
      }
    }
    for (const directory of source.articleDirectories) {
      for (const articlePath of await listMarkdownFiles(source.root, directory, (relative, entry) => this.isExcludedPath(source, relative, entry))) {
        if (this.isArticlePath(source, articlePath)) candidates.push(articlePath);
      }
    }
    return [...new Set(candidates)];
  }

  async listArticles(query = '', sourceId = '') {
    const normalizedQuery = String(query).trim().toLowerCase();
    const selectedSources = sourceId && sourceId !== 'all' ? [this.resolveSource(sourceId)] : this.sources;
    const groups = await Promise.all(selectedSources.map(async (sourceDefinition) => {
      const candidates = await this.listSourceArticles(sourceDefinition);
      return Promise.all(candidates.map(async (articlePath) => {
        const { absolute, relative, key } = this.resolveArticle(sourceDefinition.id, articlePath);
        const [markdownSource, stat] = await Promise.all([fs.readFile(absolute, 'utf8'), fs.stat(absolute)]);
        if (isExplicitlyExcluded(markdownSource)) return null;
        const fallback = path.basename(relative, '.md').replace(/[-_]/g, ' ');
        return {
          key,
          sourceId: sourceDefinition.id,
          sourceName: sourceDefinition.name,
          path: relative,
          title: titleFromMarkdown(markdownSource, fallback),
          excerpt: excerptFromMarkdown(withoutPrimaryHeading(markdownSource)),
          characters: markdownSource.length,
          updatedAt: stat.mtime.toISOString(),
          matchesQuery: !normalizedQuery || `${sourceDefinition.name}\n${relative}\n${markdownSource}`.toLowerCase().includes(normalizedQuery),
        };
      }));
    }));
    return groups.flat().filter((article) => article?.matchesQuery).map(({ matchesQuery: _matchesQuery, ...article }) => article).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readArticle(sourceId, articlePath) {
    const { absolute, relative, source: sourceDefinition, key } = this.resolveArticle(sourceId, articlePath);
    const [markdownSource, stat] = await Promise.all([fs.readFile(absolute, 'utf8'), fs.stat(absolute)]);
    if (isExplicitlyExcluded(markdownSource)) throw new Error('该 Markdown 文件已明确排除，不作为文章收录');
    const fallback = path.basename(relative, '.md').replace(/[-_]/g, ' ');
    return {
      key,
      sourceId: sourceDefinition.id,
      sourceName: sourceDefinition.name,
      path: relative,
      title: titleFromMarkdown(markdownSource, fallback),
      source: markdownSource,
      html: await renderMarkdown(sourceDefinition.root, relative, withoutPrimaryHeading(markdownSource), sourceDefinition.id),
      characters: markdownSource.length,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  async statArticle(sourceId, articlePath) {
    const { absolute, relative, source: sourceDefinition, key } = this.resolveArticle(sourceId, articlePath);
    const stat = await fs.stat(absolute);
    return {
      key,
      sourceId: sourceDefinition.id,
      path: relative,
      updatedAt: stat.mtime.toISOString(),
    };
  }
}
