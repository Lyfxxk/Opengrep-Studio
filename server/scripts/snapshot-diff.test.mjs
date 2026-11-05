import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/snapshot-diff.ts';
import { makeTempDir, writeTree } from './script-utils.mjs';

test('added/removed 与行级统计相对 before→after', async () => {
  const root = makeTempDir('og-diff-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  writeTree(before, {
    'keep.txt': 'same\n',
    'gone.txt': 'old\n',
    'change.txt': 'line1\nline2\n',
  });
  writeTree(after, {
    'keep.txt': 'same\n',
    'change.txt': 'line1\nline2\nline3\n',
    'fresh.txt': 'new\n',
  });

  const diff = await diffSnapshots(before, after);

  assert.deepEqual(diff.added, ['fresh.txt']);
  assert.deepEqual(diff.removed, ['gone.txt']);
  const changed = diff.modified.find((file) => file.path === 'change.txt');
  assert.ok(changed, 'change.txt 应进入 modified');
  assert.equal(changed.addedLines, 1, 'after 多出的 1 行应计为新增行');
  assert.equal(changed.removedLines, 0, '未删行时不应产生删除计数');
  assert.equal(diff.filesA, 3);
  assert.equal(diff.filesB, 3);
});

test('差异落在行级读取窗口之外：标记为不可逐行统计，而不是 +0 / -0', async () => {
  const root = makeTempDir('og-diff-window-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const prefix = 'a'.repeat(2 * 1024 * 1024);
  writeTree(before, { 'big.txt': `${prefix}tail-old\n` });
  writeTree(after, { 'big.txt': `${prefix}tail-new\n` });

  const diff = await diffSnapshots(before, after);
  const changed = diff.modified.find((file) => file.path === 'big.txt');
  assert.ok(changed, 'big.txt 应进入 modified');
  assert.equal(changed.diffable, false, '读取窗口外的差异不能声称逐行可统计');
  assert.equal(changed.addedLines, null);
  assert.equal(changed.removedLines, null);
});

test('大文件首尾窗口之外的中段改动仍被识别为 modified', async () => {
  const root = makeTempDir('og-diff-mid-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const head = 'a'.repeat(5 * 1024 * 1024);
  const tail = 'z'.repeat(5 * 1024 * 1024);
  writeTree(before, { 'big.bin': `${head}${'0'.repeat(2 * 1024 * 1024)}${tail}` });
  writeTree(after, { 'big.bin': `${head}${'1'.repeat(2 * 1024 * 1024)}${tail}` });

  const diff = await diffSnapshots(before, after);
  const changed = diff.modified.find((file) => file.path === 'big.bin');
  assert.ok(changed, '中段改动的大文件必须进入 modified');
});

test('modified 列表超过 500 条时截断（防大仓库撑爆响应）', async () => {
  const root = makeTempDir('og-diff-cap-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const beforeFiles = {};
  const afterFiles = {};
  for (let i = 0; i < 510; i += 1) {
    beforeFiles[`f${i}.txt`] = 'old\n';
    afterFiles[`f${i}.txt`] = 'new\n';
  }
  writeTree(before, beforeFiles);
  writeTree(after, afterFiles);

  const diff = await diffSnapshots(before, after);
  assert.equal(diff.modified.length, 500);
});
