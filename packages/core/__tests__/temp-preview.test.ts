import { describe, test, expect } from 'vitest';
import TempPreview from '../src/web/js/temp-preview.js';

const { makeTempPath, isTempPath, classifyTempFile, sniffBinary, TEMP_TEXT_LIMIT } =
  TempPreview as {
    makeTempPath: (filename: string) => string;
    isTempPath: (path: string) => boolean;
    classifyTempFile: (filename: string) => string;
    sniffBinary: (file: Blob) => Promise<boolean>;
    TEMP_TEXT_LIMIT: number;
  };

describe('TempPreview — path utilities', () => {
  test('makeTempPath generates unique temp:// paths', () => {
    const p1 = makeTempPath('test.md');
    const p2 = makeTempPath('test.md');
    expect(p1).not.toBe(p2); // unique
    expect(p1).toMatch(/^temp:\/\/[^/]+\/test\.md$/);
    expect(isTempPath(p1)).toBe(true);
  });

  test('isTempPath returns false for regular paths', () => {
    expect(isTempPath('foo/bar.md')).toBe(false);
    expect(isTempPath('')).toBe(false);
    expect(isTempPath('/api/content')).toBe(false);
    expect(isTempPath('temp://')).toBe(true); // minimal match
  });
});

describe('TempPreview — classifyTempFile', () => {
  test('returns binary-preview for images, PDF, docx, xlsx', () => {
    expect(classifyTempFile('photo.png')).toBe('binary-preview');
    expect(classifyTempFile('doc.pdf')).toBe('binary-preview');
    expect(classifyTempFile('report.docx')).toBe('binary-preview');
    expect(classifyTempFile('data.xlsx')).toBe('binary-preview');
    expect(classifyTempFile('icon.svg')).toBe('binary-preview');
    expect(classifyTempFile('image.JPG')).toBe('binary-preview'); // case insensitive
  });

  test('returns unsupported for archives, video, audio, etc.', () => {
    expect(classifyTempFile('archive.zip')).toBe('unsupported');
    expect(classifyTempFile('video.mp4')).toBe('unsupported');
    expect(classifyTempFile('sound.mp3')).toBe('unsupported');
    expect(classifyTempFile('font.ttf')).toBe('unsupported');
    expect(classifyTempFile('design.psd')).toBe('unsupported');
    expect(classifyTempFile('book.epub')).toBe('unsupported');
  });

  test('returns text-render for markdown, code, and unknown extensions', () => {
    expect(classifyTempFile('readme.md')).toBe('text-render');
    expect(classifyTempFile('index.ts')).toBe('text-render');
    expect(classifyTempFile('notes.txt')).toBe('text-render');
    expect(classifyTempFile('diagram.mermaid')).toBe('text-render');
    expect(classifyTempFile('Makefile')).toBe('text-render');
    expect(classifyTempFile('unknown.xyz')).toBe('text-render'); // unrecognized ext -> text
    expect(classifyTempFile('NO_EXT')).toBe('text-render'); // no extension -> text
  });

  test('returns TEMP_TEXT_LIMIT as 4 MB', () => {
    expect(TEMP_TEXT_LIMIT).toBe(4 * 1024 * 1024);
  });
});

describe('TempPreview — sniffBinary', () => {
  test('returns false for plain text content', async () => {
    const blob = new Blob(['Hello, world!\nThis is plain text.']);
    expect(await sniffBinary(blob)).toBe(false);
  });

  test('returns true for content with null byte', async () => {
    const buf = new Uint8Array([72, 101, 108, 108, 111, 0, 119, 111, 114, 108, 100]);
    const blob = new Blob([buf]);
    expect(await sniffBinary(blob)).toBe(true);
  });

  test('returns false for empty file', async () => {
    const blob = new Blob([]);
    expect(await sniffBinary(blob)).toBe(false);
  });
});
