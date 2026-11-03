// Builds an offline icon bundle holding only the icons the source actually uses.
//
// The default @iconify/react component fetches icons from a public API at runtime and
// paints nothing until they arrive. That breaks offline use and flashes on every load.
// Bundling them makes icon rendering synchronous. Strokes are normalized to the
// 1.5px width that PLAN.md requires, since lucide and tabler ship at 2px.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIcons } from '@iconify/utils';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const outFile = join(srcDir, 'lib', 'icons.generated.json');
const ICON_PATTERN = /['"`](lucide|tabler):([a-z0-9-]+)['"`]/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

const used = { lucide: new Set(), tabler: new Set() };
for await (const file of walk(srcDir)) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(ICON_PATTERN)) used[match[1]].add(match[2]);
}

const output = [];
const missing = [];
for (const prefix of Object.keys(used)) {
  const names = [...used[prefix]].sort();
  if (names.length === 0) continue;
  const raw = await readFile(join(root, 'node_modules', '@iconify-json', prefix, 'icons.json'), 'utf8');
  const set = JSON.parse(raw);
  const subset = getIcons(set, names, true);
  if (!subset) throw new Error(`Could not read the ${prefix} icon set`);
  for (const name of subset.not_found ?? []) missing.push(`${prefix}:${name}`);
  delete subset.not_found;
  delete subset.lastModified;
  for (const icon of Object.values(subset.icons)) {
    icon.body = icon.body.replace(/stroke-width="[\d.]+"/g, 'stroke-width="1.5"');
  }
  output.push(subset);
}

if (missing.length > 0) {
  console.error(`Unknown icons: ${missing.join(', ')}`);
  process.exit(1);
}

const json = `${JSON.stringify(output)}\n`;
await mkdir(dirname(outFile), { recursive: true });
let current = '';
try {
  current = await readFile(outFile, 'utf8');
} catch {
  current = '';
}
// Unchanged output skips the write so the dev server is not forced to reload.
if (current !== json) await writeFile(outFile, json);

const total = used.lucide.size + used.tabler.size;
console.log(`Bundled ${total} icons into ${relative(root, outFile)} (${(json.length / 1024).toFixed(1)} KB)`);
