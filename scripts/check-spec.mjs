// Static checks for the hard rules in PLAN.md section 1 and section 4.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// Emoji_Presentation plus the variation selector covers every code point that renders
// as an emoji by default, without flagging ordinary symbols such as a copyright sign.
const EMOJI = /\p{Emoji_Presentation}|\u{FE0F}/u;
const SCAN_ROOTS = ['src', 'src-tauri/src', 'src-tauri/capabilities', 'e2e', 'scripts', 'docs', 'public', 'index.html', 'README.md', 'src-tauri/tauri.conf.json'];
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.rs', '.css', '.json', '.js', '.mjs', '.html', '.md', '.toml']);

async function* walk(path) {
  const full = join(root, path);
  if (!existsSync(full)) return;
  if (extname(full)) {
    yield full;
    return;
  }
  for (const entry of await readdir(full, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) yield join(root, child);
  }
}

let scanned = 0;
for (const scanRoot of SCAN_ROOTS) {
  for await (const file of walk(scanRoot)) {
    if (file.endsWith('icons.generated.json')) continue;
    scanned += 1;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (EMOJI.test(line)) failures.push(`Emoji in ${relative(root, file)}:${index + 1}`);
    });
  }
}

// Icons come only from @iconify/react, in the lucide and tabler collections.
const FORBIDDEN_ICON_LIBS = /from ['"](lucide-react|react-icons|@heroicons|@tabler\/icons-react|@radix-ui\/react-icons|@fortawesome)/;
for await (const file of walk('src')) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  if (FORBIDDEN_ICON_LIBS.test(text)) failures.push(`Forbidden icon library in ${relative(root, file)}`);
  for (const match of text.matchAll(/['"`]([a-z0-9-]+):([a-z0-9-]+)['"`]/g)) {
    const [, prefix] = match;
    if (['mdi', 'fa', 'ph', 'heroicons', 'carbon', 'bi', 'ri', 'noto', 'twemoji', 'openmoji'].includes(prefix)) {
      failures.push(`Icon from a forbidden collection (${match[0]}) in ${relative(root, file)}`);
    }
  }
}

const icons = JSON.parse(await readFile(join(root, 'src/lib/icons.generated.json'), 'utf8'));
for (const set of icons) {
  if (!['lucide', 'tabler'].includes(set.prefix)) failures.push(`Unexpected icon set ${set.prefix}`);
  for (const [name, icon] of Object.entries(set.icons)) {
    const widths = [...icon.body.matchAll(/stroke-width="([\d.]+)"/g)].map((match) => match[1]);
    if (widths.some((width) => width !== '1.5')) failures.push(`Icon ${set.prefix}:${name} is not 1.5px`);
  }
}

// The directory structure from PLAN.md section 4.
const REQUIRED_FILES = [
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/hardware.rs',
  'src-tauri/src/ollama.rs',
  'src-tauri/src/storage.rs',
  'src/main.tsx',
  'src/App.tsx',
  'src/styles/globals.css',
  'src/types/deck.ts',
  'src/store/useDeckStore.ts',
  'src/components/layout/Sidebar.tsx',
  'src/components/layout/Topbar.tsx',
  'src/components/script/ScriptStudioPane.tsx',
  'src/components/canvas/SlideDeckCanvas.tsx',
  'src/components/canvas/ImageDropzone.tsx',
  'src/components/canvas/AnnotatedImage.tsx',
  'src/components/models/ModelManagerModal.tsx',
  'src/components/presentation/VipPresenterModal.tsx',
];
for (const file of REQUIRED_FILES) {
  if (!existsSync(join(root, file))) failures.push(`Missing ${file}`);
}

// The exact Notion tokens from PLAN.md section 1.
const css = await readFile(join(root, 'src/styles/globals.css'), 'utf8');
const lightBlock = css.slice(css.indexOf('[data-theme=\'light\']'), css.indexOf("[data-theme='dark'] {"));
const darkBlock = css.slice(css.indexOf("[data-theme='dark'] {"), css.indexOf('@theme inline'));
const TOKENS = [
  [lightBlock, '--bg-primary', '#ffffff'],
  [lightBlock, '--bg-sidebar', '#f7f7f5'],
  [lightBlock, '--bg-hover', '#efefed'],
  [lightBlock, '--text-primary', '#37352f'],
  [lightBlock, '--text-secondary', '#787774'],
  [lightBlock, '--text-muted', '#9b9a97'],
  [lightBlock, '--border-hairline', '#e9e9e7'],
  [lightBlock, '--accent-blue', '#2383e2'],
  [darkBlock, '--bg-primary', '#191919'],
  [darkBlock, '--bg-sidebar', '#202020'],
  [darkBlock, '--bg-hover', '#2c2c2b'],
  [darkBlock, '--text-primary', '#d4d4d4'],
  [darkBlock, '--text-secondary', '#9b9a97'],
  [darkBlock, '--border-hairline', '#2f2f2f'],
  [darkBlock, '--accent-blue', '#2383e2'],
];
for (const [block, token, value] of TOKENS) {
  if (!block.includes(`${token}: ${value}`)) failures.push(`Token ${token} is not ${value}`);
}

if (failures.length > 0) {
  console.error(`Spec check failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Spec check passed: ${scanned} files scanned, zero emoji, icons limited to lucide and tabler at 1.5px, ${REQUIRED_FILES.length} plan files present, ${TOKENS.length} tokens exact.`);
