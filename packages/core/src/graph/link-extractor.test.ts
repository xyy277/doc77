import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  extractLinksFromContent,
  createLinkResolver,
  type ExtractedLink,
} from './link-extractor.js';
import { extractDocMeta } from './frontmatter.js';

function makeProject(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-graph-extract-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function extract(content: string, fromRel: string, root: string): ExtractedLink[] {
  return extractLinksFromContent(content, fromRel, createLinkResolver(root));
}

describe('link-extractor', () => {
  it('wikilink 精确匹配（basename）', () => {
    const { root, cleanup } = makeProject({ 'a.md': '', 'docs/b.md': '' });
    try {
      const links = extract('参见 [[b]] 和 [[a]]', 'a.md', root);
      expect(links).toHaveLength(2);
      expect(links[0]).toMatchObject({ toPath: 'docs/b.md', linkType: 'wikilink' });
      expect(links[1]).toMatchObject({ toPath: 'a.md', linkType: 'wikilink' });
    } finally {
      cleanup();
    }
  });

  it('wikilink 大小写不敏感匹配', () => {
    const { root, cleanup } = makeProject({ 'ReadMe.md': '' });
    try {
      const links = extract('见 [[readme]]', 'a.md', root);
      expect(links[0].toPath).toBe('ReadMe.md');
    } finally {
      cleanup();
    }
  });

  it('wikilink 别名（.doc77links）', () => {
    const { root, cleanup } = makeProject({
      'docs/guide.md': '',
      '.doc77links': '使用指南 → docs/guide.md\n',
    });
    try {
      const links = extract('见 [[使用指南]]', 'a.md', root);
      expect(links[0].toPath).toBe('docs/guide.md');
    } finally {
      cleanup();
    }
  });

  it('wikilink 死链返回 null（入库时 status=broken）', () => {
    const { root, cleanup } = makeProject({ 'a.md': '' });
    try {
      const links = extract('见 [[不存在的文档]]', 'a.md', root);
      expect(links[0].toPath).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('wikilink #锚点 与 |display', () => {
    const { root, cleanup } = makeProject({ 'docs/topic.md': '' });
    try {
      const links = extract('见 [[topic#安装|安装说明]]', 'a.md', root);
      expect(links[0]).toMatchObject({
        toPath: 'docs/topic.md',
        anchor: '#安装',
        display: '安装说明',
      });
    } finally {
      cleanup();
    }
  });

  it('relative 链接按当前目录解析', () => {
    const { root, cleanup } = makeProject({ 'docs/a.md': '', 'docs/sub/b.md': '' });
    try {
      const links = extract('[说明](sub/b.md)', 'docs/a.md', root);
      expect(links[0]).toMatchObject({ toPath: 'docs/sub/b.md', linkType: 'relative' });
    } finally {
      cleanup();
    }
  });

  it('relative 越界（../../ 逃出项目根）被忽略', () => {
    const { root, cleanup } = makeProject({ 'docs/a.md': '' });
    try {
      const links = extract('[逃逸](../../outside.md)', 'docs/a.md', root);
      expect(links).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('relative ../ 指向项目根内文件是合法链接（normalize 后落根内）', () => {
    const { root, cleanup } = makeProject({ 'docs/a.md': '', 'outside.md': '' });
    try {
      const links = extract('[兄弟](../outside.md)', 'docs/a.md', root);
      expect(links[0].toPath).toBe('outside.md');
    } finally {
      cleanup();
    }
  });

  it('外部 URL 与非 markdown 目标被过滤', () => {
    const { root, cleanup } = makeProject({ 'a.md': '', 'img/pic.png': 'x' });
    try {
      const links = extract('[外链](https://example.com) 和 [图](../img/pic.png)', 'a.md', root);
      expect(links).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('fenced code 与 inline code 内的链接不提取', () => {
    const { root, cleanup } = makeProject({ 'a.md': '', 'real.md': '' });
    try {
      const content =
        '正文 [[real]]\n\n```\n[[fake]] 和 [链接](fake.md)\n```\n行内 `[[fake2]]` 结束';
      const links = extract(content, 'a.md', root);
      expect(links).toHaveLength(1);
      expect(links[0].toPath).toBe('real.md');
    } finally {
      cleanup();
    }
  });

  it('重复链接去重不强制（保留原文出现；入库层负责去重）', () => {
    const { root, cleanup } = makeProject({ 'a.md': '', 'b.md': '' });
    try {
      const links = extract('[[b]] 和 [[b]]', 'a.md', root);
      expect(links).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('死链 relative 目标不存在时 toPath 为 null', () => {
    const { root, cleanup } = makeProject({ 'a.md': '' });
    try {
      const links = extract('[缺失](missing.md)', 'a.md', root);
      expect(links[0].toPath).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('frontmatter（extractDocMeta）', () => {
  it('title 取一级标题，无标题时取文件名', () => {
    expect(extractDocMeta('# 我的标题\n正文', 'docs/a.md').title).toBe('我的标题');
    expect(extractDocMeta('无标题正文', 'docs/b.md').title).toBe('b.md');
  });

  it('tags/aliases：行内数组与列表两种写法', () => {
    const meta = extractDocMeta(
      '---\ntags: [笔记, 知识库]\naliases:\n  - 别名A\n  - 别名B\n---\n# 标题\n',
      'a.md',
    );
    expect(meta.tags).toEqual(['笔记', '知识库']);
    expect(meta.aliases).toEqual(['别名A', '别名B']);
  });

  it('无 frontmatter 返回空数组', () => {
    const meta = extractDocMeta('# 标题\n正文', 'a.md');
    expect(meta.tags).toEqual([]);
    expect(meta.aliases).toEqual([]);
  });
});
