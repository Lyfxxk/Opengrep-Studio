// 双快照文件级 diff 方向回归（node --test 运行，`npm test` 统一驱动）
// 历史 bug：路由把「当前扫描」当 before 传给 diffSnapshots，added/removed 与行级 +/- 全部反向，
// 界面把新增文件显示成删除文件。这里锁住 before（旧）→ after（新）的方向约定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/snapshot-diff.ts';

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('added/removed 与行级统计相对 before→after', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-diff-'));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  try {
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('modified 列表超过 500 条时截断（防大仓库撑爆响应）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-diff-cap-'));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  try {
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
