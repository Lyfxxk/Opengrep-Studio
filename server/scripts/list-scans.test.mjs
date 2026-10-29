// 全量扫描列表回归（node --test 运行，`npm test` 统一驱动）
// 历史 bug：listAllScans 固定 LIMIT 200，扫描超过 200 条后更早的记录在扫描中心、
// 报告中心与双快照对比候选池里静默消失（前端分页只是在这 200 条内翻页）。
// DATA_DIR 必须在动态导入 config/db 之前指向临时目录，单测不碰 server/data/ 的真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-list-scans-'));

const { insertProject, insertScan, listAllScans } = await import('../src/db.ts');

const now = '2026-10-29T00:00:00.000Z';

test('listAllScans 不做 200 条静默截断', () => {
  insertProject({ id: 'p-test', name: 'test', language: '', createdAt: now });
  for (let i = 0; i < 205; i += 1) {
    insertScan({
      id: `scan-${String(i).padStart(3, '0')}`,
      projectId: 'p-test',
      status: 'completed',
      issueCount: 0,
      scannedAt: now,
      fileCount: 1,
    });
  }
  assert.equal(listAllScans().length, 205);
});
