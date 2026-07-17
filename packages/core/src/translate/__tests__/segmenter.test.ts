import { describe, it, expect } from 'vitest';
import { segmentText } from '../segmenter.js';

describe('segmentText', () => {
  it('returns single segment for short text', () => {
    const result = segmentText('Hello world');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Hello world');
  });

  it('keeps short Chinese text in one segment', () => {
    const text = '这是第一句话。这是第二句话！';
    const result = segmentText(text);
    expect(result).toHaveLength(1);
  });

  it('splits long paragraph by sentence-ending punctuation', () => {
    const long = 'A'.repeat(350) + '. ';
    const text = long + long;
    const result = segmentText(text);
    expect(result.length).toBeGreaterThan(1);
  });

  it('handles empty input', () => {
    expect(segmentText('')).toHaveLength(0);
  });

  it('handles very long text without punctuation (hard split)', () => {
    const longText = 'X'.repeat(800);
    const result = segmentText(longText);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const seg of result) {
      expect(seg.text.length).toBeLessThanOrEqual(300);
    }
  });
});
