/**
 * Text segmenter — splits text for Opus-MT's ~200-token limit.
 */
export interface Segment {
  text: string;
  offset: number;
}

const MAX_SEGMENT_CHARS = 300;
const SENTENCE_END = /([。！？.!?])\s*/g;
const CLAUSE_BOUNDARY = /([,;，；])\s*/g;

export function segmentText(text: string, maxChars = MAX_SEGMENT_CHARS): Segment[] {
  const segments: Segment[] = [];
  let offset = 0;
  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    if (!para.trim()) {
      offset += para.length + 2;
      continue;
    }

    if (para.length <= maxChars) {
      segments.push({ text: para, offset });
      offset += para.length + 2;
      continue;
    }

    const sentences = splitByRegex(para, SENTENCE_END);
    let paraOffset = 0;
    for (const sentence of sentences) {
      if (sentence.length <= maxChars) {
        segments.push({ text: sentence, offset: offset + paraOffset });
        paraOffset += sentence.length;
        continue;
      }
      const clauses = splitByRegex(sentence, CLAUSE_BOUNDARY);
      let sentOffset = 0;
      for (const clause of clauses) {
        if (clause.length <= maxChars) {
          segments.push({ text: clause, offset: offset + paraOffset + sentOffset });
          sentOffset += clause.length;
          continue;
        }
        const chunks = hardSplit(clause, maxChars);
        for (const chunk of chunks) {
          segments.push({ text: chunk, offset: offset + paraOffset + sentOffset });
          sentOffset += chunk.length;
        }
      }
      paraOffset += sentence.length;
    }
    offset += para.length + 2;
  }
  return segments;
}

function splitByRegex(text: string, regex: RegExp): string[] {
  const parts: string[] = [];
  let lastIndex = 0;
  const g = new RegExp(regex.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, g.lastIndex));
    lastIndex = g.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : [text];
}

function hardSplit(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = maxChars;
    const si = remaining.lastIndexOf(' ', maxChars);
    if (si > maxChars * 0.5) splitAt = si;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
