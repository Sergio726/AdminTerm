// Copia los builds UMD de xterm y sus addons a src/renderer/vendor.
// Asi el renderer los carga con <script src="..."> sin necesitar un bundler.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'src', 'renderer', 'vendor');

const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-search/lib/addon-search.js', 'addon-search.js'],
  ['@xterm/addon-unicode11/lib/addon-unicode11.js', 'addon-unicode11.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
  ['@xterm/addon-webgl/lib/addon-webgl.js', 'addon-webgl.js'],
];

fs.mkdirSync(dest, { recursive: true });

let copied = 0;
const missing = [];
for (const [rel, out] of FILES) {
  const src = path.join(root, 'node_modules', ...rel.split('/'));
  if (!fs.existsSync(src)) {
    missing.push(rel);
    continue;
  }
  fs.copyFileSync(src, path.join(dest, out));
  copied++;
}

console.log(`[vendor] ${copied}/${FILES.length} archivos copiados en ${dest}`);
if (missing.length) {
  console.warn('[vendor] No encontrados (revisa npm install):\n  - ' + missing.join('\n  - '));
  process.exitCode = 1;
}
