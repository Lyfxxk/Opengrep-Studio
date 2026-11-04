import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

function serverFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(srcDir);
  return files;
}

test('每个 HttpError 都必须携带 code，否则非中文界面会漏出中文原文', () => {
  const bad = [];
  for (const file of serverFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/new HttpError\(/g)) {
      const end = text.indexOf(');', match.index);
      const block = text.slice(match.index, end === -1 ? match.index + 200 : end + 2);
      if (!/(^|[^\w])code\s*[:},]/.test(block)) {
        bad.push(`${path.relative(srcDir, file)}：${block.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
