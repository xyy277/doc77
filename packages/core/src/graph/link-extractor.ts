import * as path from 'node:path';
import * as fs from 'node:fs';
import { createWikilinkIndex, loadAliasMap } from '../renderers/wikilink.js';
import { walkDir } from '../search/indexer.js';

/**
 * 知识图谱链接提取器（v1.2.0）。
 *
 * 与渲染期解析（renderers/markdown.ts + wikilink.ts）解耦的索引期提取：
 * 渲染负责显示（obsidian_mode 门控），提取负责数据结构（全局生效）。
 * 语义与渲染期保持一致（别名表、大小写匹配、rewriteLocalUrl 的路径解析）。
 */

export type LinkType = 'wikilink' | 'relative';

export interface ExtractedLink {
  /** resolved 目标的相对路径（posix）；null = 死链（入库 status='broken'） */
  toPath: string | null;
  linkType: LinkType;
  /** '#锚点' 或 ''（wikilink `[[标题#锚点]]` 与 markdown 链接锚点） */
  anchor: string;
  /** 显示文本（`[[标题|显示]]` 的显示部分 / 链接文字） */
  display: string;
  raw: string;
}

export interface LinkResolver {
  /** 解析 `[[标题]]`，返回相对路径（posix）或 null（死链） */
  resolveWikilink(title: string): string | null;
  /** 相对路径（posix，已规范化）目标是否存在于项目内 */
  fileExists(relPath: string): boolean;
}

/** 仅索引 markdown 家族的文档链接（图谱节点是文档） */
const MD_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

function isMarkdownFile(relPath: string): boolean {
  return MD_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/**
 * 剥离 fenced code block 与 inline code —— 防止代码示例里的 `[[x]]`/链接
 * 污染图谱（渲染期正则无此保护，提取层必须补）。
 * 返回 (可提取文本, 偏移映射省略版) —— 用占位替换保持行结构。
 */
function stripCode(content: string): string {
  // fenced code blocks (```lang ... ```) 与 inline code (`...`) 整体替换为空白
  return content
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/** 收集项目内全部文件（绝对路径，posix 相对路径全集） */
function collectProjectFiles(projectRoot: string): string[] {
  return walkDir(projectRoot, projectRoot).map((rel) => path.join(projectRoot, rel));
}

/**
 * 创建链接解析器。fileList 可选：全量索引时由调用方一次遍历传入
 * （绝对路径列表），避免重复磁盘扫描。
 */
export function createLinkResolver(projectRoot: string, fileList?: string[]): LinkResolver {
  const allFiles = fileList ?? collectProjectFiles(projectRoot);
  const aliasMap = loadAliasMap(projectRoot);
  // v1.2.1 红队修复：构造期建一次索引（basename Map + 全文件 Set）——
  // 修复前每链接线性扫描 allFiles（O(链接×文件)）且 fileExists 用
  // includes（O(n)）。现在 resolve O(1)、fileExists O(1)。
  const index = createWikilinkIndex(allFiles, aliasMap, projectRoot);

  const toRel = (absPath: string): string =>
    path.relative(projectRoot, absPath).split(path.sep).join('/');

  return {
    resolveWikilink(title: string): string | null {
      const abs = index.resolve(title);
      return abs ? toRel(abs) : null;
    },
    fileExists(relPath: string): boolean {
      const abs = path.resolve(projectRoot, relPath);
      return index.has(abs) || fs.existsSync(abs);
    },
  };
}

/**
 * 从文档内容提取全部链接。
 *
 * @param content 文件内容
 * @param fromRelPath 源文件相对路径（posix）
 * @param resolver 链接解析器（wikilink 目标解析 + 相对路径存在性）
 */
export function extractLinksFromContent(
  content: string,
  fromRelPath: string,
  resolver: LinkResolver,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const text = stripCode(content);
  const fromDir = path.posix.dirname(fromRelPath);

  // ── wikilink 扫描（正则与 renderers/markdown.ts 的 tokenizer 同构）──
  const wikiRe = /\[\[([^\[\]]+?)(?:\|([^\[\]]*?))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(text)) !== null) {
    const raw = m[0];
    const titlePart = m[1];
    const display = m[2] ?? '';
    // `[[标题#锚点]]`：先拆锚点（渲染期 resolveWikilink 不认识锚点，提取层新增能力）
    const hashIdx = titlePart.indexOf('#');
    const title = hashIdx >= 0 ? titlePart.slice(0, hashIdx) : titlePart;
    const anchor = hashIdx >= 0 ? titlePart.slice(hashIdx) : '';
    const toRel = resolver.resolveWikilink(title);
    links.push({
      toPath: toRel,
      linkType: 'wikilink',
      anchor,
      display,
      raw,
    });
  }

  // ── relative / markdown 链接扫描（含图片，但非 markdown 目标丢弃）──
  const relRe = /!?\[([^\]]*)\]\(([^()\s]+)\)/g;
  while ((m = relRe.exec(text)) !== null) {
    const raw = m[0];
    const display = m[1] ?? '';
    let url = m[2];
    // 过滤外部 URL / 页内锚点
    if (/^(https?:|mailto:|ftp:|data:|blob:)/i.test(url)) continue;
    if (url.startsWith('#')) continue;

    // 拆锚点
    const hashIdx = url.indexOf('#');
    const anchor = hashIdx >= 0 ? url.slice(hashIdx) : '';
    const pathPart = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    if (!pathPart) continue;

    // 规范化相对路径（复刻 rewriteLocalUrl 语义），统一 posix。
    // 越界检查：相对路径语义下逃离项目根的充要条件是 ../ 前缀
    // （posix normalize 已折叠冗余段）；绝对路径引用不属于项目内链接。
    let rel = path.posix.normalize(path.posix.join(fromDir, pathPart));
    if (rel === '..' || rel.startsWith('../')) continue;
    if (path.posix.isAbsolute(rel)) continue;
    // 仅索引 markdown 家族目标
    if (!isMarkdownFile(rel)) continue;

    links.push({
      toPath: resolver.fileExists(rel) ? rel : null,
      linkType: 'relative',
      anchor,
      display,
      raw,
    });
  }

  return links;
}
