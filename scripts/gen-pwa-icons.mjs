/**
 * Generate PWA icons from the Doc77 SVG logo.
 * Usage: node scripts/gen-pwa-icons.mjs
 * Requires: sharp (available via @doc77/gallery dependency)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const iconsDir = join(root, 'packages', 'core', 'src', 'web', 'icons');

// Ensure output directory
if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });

const svgSource = readFileSync(join(root, 'packages', 'core', 'src', 'web', 'assets', 'favicon.svg'), 'utf-8');

// Create a padded version for maskable icon (safe zone = 80% center)
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#1e293b" rx="4"/>
  <g transform="translate(4.8, 4.8) scale(0.7)">
    <path d="M6 4 C6 2.895 6.895 2 8 2 H19.172 C19.702 2 20.211 2.211 20.586 2.586 L27.414 9.414 C27.789 9.789 28 10.298 28 10.828 V28 C28 29.105 27.105 30 26 30 H8 C6.895 30 6 29.105 6 28 V4 Z" fill="#2563EB"/>
    <path d="M19 2 V9 C19 10.105 19.895 11 21 11 H28 L19 2 Z" fill="#60A5FA"/>
    <path d="M11 15 H16.5 L13.5 24 M17 15 H22.5 L19.5 24" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M9 10 L10 7.5 L12.5 6.5 L10 5.5 L9 3 L8 5.5 L5.5 6.5 L8 7.5 Z" fill="#FCD34D"/>
  </g>
</svg>`;

async function generate() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('sharp not available. Install @doc77/gallery or run: pnpm add -D sharp');
    console.log('Generating SVG fallback icons instead...');
    // Fallback: write SVG icons (modern browsers support SVG in manifest)
    writeFileSync(join(iconsDir, 'icon.svg'), svgSource);
    writeFileSync(join(iconsDir, 'icon-maskable.svg'), maskableSvg);
    console.log('✓ SVG icons written (PNG generation requires sharp)');
    return;
  }

  const sizes = [
    { name: 'icon-192.png', size: 192, svg: svgSource },
    { name: 'icon-512.png', size: 512, svg: svgSource },
    { name: 'icon-maskable-512.png', size: 512, svg: maskableSvg },
  ];

  for (const { name, size, svg } of sizes) {
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(join(iconsDir, name));
    console.log(`✓ ${name} (${size}x${size})`);
  }
}

generate().catch(console.error);
