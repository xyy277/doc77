import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateThumbnail } from '../src/thumbnail/engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('generateThumbnail', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-test-'));
  const outDir = path.join(tmpDir, 'thumbnails');
  const testImg = path.join(tmpDir, 'test.png');

  beforeAll(async () => {
    // Create a minimal 100x100 red PNG using sharp
    const sharp = await import('sharp');
    await sharp.default({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toFile(testImg);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a grid thumbnail from a test image', async () => {
    const result = await generateThumbnail(tmpDir, 'test.png', 1, 'grid', outDir);

    expect(result.cachePath).toContain('_grid.webp');
    expect(fs.existsSync(result.cachePath)).toBe(true);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('creates a preview thumbnail from a test image', async () => {
    const result = await generateThumbnail(tmpDir, 'test.png', 1, 'preview', outDir);

    expect(result.cachePath).toContain('_preview.webp');
    expect(fs.existsSync(result.cachePath)).toBe(true);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });
});
