import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const omitted = new Set(['node_modules', '.next', 'out', '.git', '.vercel', '.npm-cache', 'SOURCE.md', 'package-lock.json', 'tsconfig.tsbuildinfo']);
async function walk(dir = '.') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (omitted.has(entry.name) || entry.name.endsWith('.png')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else result.push(file);
  }
  return result.sort();
}
const files = await walk();
let output = '# Periscope — complete project source\n\nThe generated package-lock.json is supplied alongside this document.\n\n## File tree\n\n```text\n' + files.join('\n') + '\npackage-lock.json\n```\n';
for (const file of files) output += '\n## ' + file + '\n\n```' + (path.extname(file).slice(1) || 'text') + '\n' + await readFile(file, 'utf8') + '\n```\n';
await writeFile('SOURCE.md', output);
