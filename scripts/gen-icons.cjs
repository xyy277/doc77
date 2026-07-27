const sharp = require('D:/code/doc77/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, '..', 'packages', 'core', 'src', 'web', 'icons');
const svg = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'src', 'web', 'assets', 'favicon.svg'));

const maskable = Buffer.from([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
  '<rect width="32" height="32" fill="#1e293b" rx="4"/>',
  '<g transform="translate(4.8,4.8) scale(0.7)">',
  '<path d="M6 4 C6 2.895 6.895 2 8 2 H19.172 C19.702 2 20.211 2.211 20.586 2.586 L27.414 9.414 C27.789 9.789 28 10.298 28 10.828 V28 C28 29.105 27.105 30 26 30 H8 C6.895 30 6 29.105 6 28 V4 Z" fill="#2563EB"/>',
  '<path d="M19 2 V9 C19 10.105 19.895 11 21 11 H28 L19 2 Z" fill="#60A5FA"/>',
  '<path d="M11 15 H16.5 L13.5 24 M17 15 H22.5 L19.5 24" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  '<path d="M9 10 L10 7.5 L12.5 6.5 L10 5.5 L9 3 L8 5.5 L5.5 6.5 L8 7.5 Z" fill="#FCD34D"/>',
  '</g></svg>'
].join(''));

async function gen() {
  await sharp(Buffer.from(svg)).resize(192, 192).png().toFile(path.join(iconsDir, 'icon-192.png'));
  console.log('icon-192.png done');
  await sharp(Buffer.from(svg)).resize(512, 512).png().toFile(path.join(iconsDir, 'icon-512.png'));
  console.log('icon-512.png done');
  await sharp(maskable).resize(512, 512).png().toFile(path.join(iconsDir, 'icon-maskable-512.png'));
  console.log('icon-maskable-512.png done');
}

gen().catch(e => { console.error(e); process.exit(1); });
