/**
 * 文档分块器 — 将长文档切分为适合嵌入的固定大小块。
 *
 * 策略：
 * 1. 优先按段落分块（双换行分割）
 * 2. 若段落超过 maxChunkSize，按 maxChunkSize 硬切（带 overlap 重叠避免上下文断裂）
 * 3. 若段落小于 minChunkSize，尝试与下一段合并
 */
export interface ChunkOptions {
  /** 单块最大字符数（默认 1000） */
  maxChunkSize?: number;
  /** 单块最小字符数（默认 100，低于此值尝试合并） */
  minChunkSize?: number;
  /** 硬切时的重叠字符数（默认 100） */
  overlap?: number;
}

export interface TextChunk {
  /** 块在原文中的序号（0-based） */
  index: number;
  /** 块文本内容 */
  content: string;
  /** 块起始字符偏移 */
  startOffset: number;
}

/**
 * 将文档切分为块。
 *
 * @param text 原始文档文本
 * @param opts 分块参数
 * @returns 块数组（按顺序）
 */
export function chunkDocument(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxChunkSize = opts.maxChunkSize ?? 1000;
  const minChunkSize = opts.minChunkSize ?? 30;
  const overlap = opts.overlap ?? 100;

  if (!text || text.trim().length === 0) return [];

  const chunks: TextChunk[] = [];
  let offset = 0;

  // 按段落分割（双换行）
  const paragraphs = text.split(/\n\s*\n/);

  let buffer = '';
  let bufferStart = 0;

  for (const para of paragraphs) {
    const paraTrimmed = para.trim();
    if (!paraTrimmed) {
      offset += para.length + 2; // \n\n
      continue;
    }

    // 若段落本身超过 maxChunkSize，先 flush buffer，再硬切段落
    if (paraTrimmed.length > maxChunkSize) {
      // flush 现有 buffer
      if (buffer.length >= minChunkSize) {
        chunks.push({ index: chunks.length, content: buffer.trim(), startOffset: bufferStart });
        buffer = '';
      }
      // 硬切长段落
      let pos = 0;
      while (pos < paraTrimmed.length) {
        const end = Math.min(pos + maxChunkSize, paraTrimmed.length);
        const slice = paraTrimmed.slice(pos, end);
        chunks.push({
          index: chunks.length,
          content: slice,
          startOffset: offset + pos,
        });
        if (end >= paraTrimmed.length) break;
        pos = end - overlap; // 重叠
        if (pos < 0) pos = 0;
      }
      buffer = '';
      bufferStart = offset + paraTrimmed.length;
    } else if (buffer.length + paraTrimmed.length + 2 > maxChunkSize) {
      // buffer + 当前段落会超限，先 flush buffer
      if (buffer.length >= minChunkSize) {
        chunks.push({ index: chunks.length, content: buffer.trim(), startOffset: bufferStart });
      }
      buffer = paraTrimmed;
      bufferStart = offset;
    } else {
      // 追加到 buffer
      if (buffer) buffer += '\n\n' + paraTrimmed;
      else {
        buffer = paraTrimmed;
        bufferStart = offset;
      }
    }
    offset += para.length + 2; // \n\n
  }

  // flush 最后的 buffer
  if (buffer && buffer.length >= minChunkSize) {
    chunks.push({ index: chunks.length, content: buffer.trim(), startOffset: bufferStart });
  }

  return chunks;
}
