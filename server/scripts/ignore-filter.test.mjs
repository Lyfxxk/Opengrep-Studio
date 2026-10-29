// pruneIgnoredFiles 的 gitignore 语义单测（node --test 运行，`npm test` 统一驱动）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneIgnoredFiles } from '../src/ignore-filter.ts';

/** @param {Record<string, string | null>} files */
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igtest-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content === null) fs.mkdirSync(full, { recursive: true });
    else fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

// 规则文件本身（.gitignore 等）是快照的一部分，计入 keptFiles——与扫描时 countFiles 口径一致。

test('目录整棵剪除且否定规则不复活', async () => {
  const dir = makeFixture({
    '.gitignore': '.env\ndist/\n!dist/keep.js\n',
    'app.ts': 'x',
    '.env': 'SECRET=1',
    'dist/bundle.js': 'x',
    'dist/keep.js': 'x',
    'src/lib.ts': 'x',
  });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 3);
  assert.equal(r.ignoredFiles, 3);
  assert.ok(!fs.existsSync(path.join(dir, '.env')));
  assert.ok(!fs.existsSync(path.join(dir, 'dist')));
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')), '规则文件本身保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('深层否定规则覆盖浅层', async () => {
  const dir = makeFixture({
    '.gitignore': '*.log\n',
    'a/inner/.gitignore': '!debug.log\n',
    'a/run.log': 'x',
    'a/inner/debug.log': 'x',
    'b/other.log': 'x',
  });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 3);
  assert.equal(r.ignoredFiles, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('锚定模式只匹配同层级', async () => {
  const dir = makeFixture({
    '.gitignore': '/build\n*.tmp\n',
    'build/root.js': 'x',
    'app/build/nested.js': 'x',
    'app/scratch.tmp': 'x',
    'main.ts': 'x',
  });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 3);
  assert.equal(r.ignoredFiles, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dist/* 保留子目录内被否定的文件；CRLF 规则文件', async () => {
  const dir = makeFixture({
    '.gitignore': 'dist/*\r\n!dist/keep.js\r\n',
    'dist/gen.js': 'x',
    'dist/keep.js': 'x',
    'app.ts': 'x',
  });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 3);
  assert.equal(r.ignoredFiles, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('node_modules / .git 强制静默剪除', async () => {
  const dir = makeFixture({
    'app.ts': 'x',
    'node_modules/pkg/index.js': 'x',
    '.git/HEAD': 'ref',
    'sub/node_modules/pkg2/index.js': 'x',
  });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 1);
  assert.equal(r.ignoredFiles, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无规则文件时零剪枝', async () => {
  const dir = makeFixture({ 'a.ts': 'x', 'sub/b.ts': 'x' });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 2);
  assert.equal(r.ignoredFiles, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.opengrepignore 优先级高于同目录 .gitignore', async () => {
  const dir = makeFixture({
    '.gitignore': '*.json\n',
    '.opengrepignore': '!keep.json\n',
    'keep.json': 'x',
    'other.json': 'x',
  });
  const r = await pruneIgnoredFiles(dir);
  assert.equal(r.keptFiles, 3);
  assert.equal(r.ignoredFiles, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
