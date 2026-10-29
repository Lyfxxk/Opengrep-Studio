// deleteScan 基线引用清理回归（node --test 运行，`npm test` 统一驱动）
// 历史 bug：删除作为基线的扫描时只清了 scans.baseline_scan_id，projects.baseline_scan_id
// 悬空后前端发扫描恒带死 ID 被 400 卡死，且界面上没有解除入口。这里锁住「两张表都清」的行为。
// DATA_DIR 必须在动态导入 config/db 之前指向临时目录，单测不碰 server/data/ 的真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-baseline-'));
process.env.DATA_DIR = tempDataDir;

const { deleteScan, insertProject, insertScan, getProject, getScan, closeDatabase } =
  await import('../src/db.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

const now = '2026-10-29T00:00:00.000Z';

function seedScan(id, projectId, baselineScanId) {
  insertScan({ id, projectId, status: 'completed', issueCount: 0, scannedAt: now, baselineScanId });
}

test('删除作为基线的扫描后，项目本身与其他扫描指向它的基线引用都置空', () => {
  insertProject({
    id: 'proj-a',
    name: 'A',
    language: 'javascript',
    createdAt: now,
    baselineScanId: 'scan-base',
  });
  seedScan('scan-base', 'proj-a');
  // 后续扫描以 scan-base 为对比基线（scans 表引用，既有行为一并守护）
  seedScan('scan-followup', 'proj-a', 'scan-base');

  deleteScan('scan-base');

  assert.equal(getScan('scan-base'), undefined);
  assert.equal(getProject('proj-a')?.baselineScanId, undefined);
  assert.equal(getScan('scan-followup')?.baselineScanId, undefined);
});

test('deleteScan 只清指向被删扫描的引用，其他项目的基线不受影响', () => {
  insertProject({
    id: 'proj-b',
    name: 'B',
    language: 'javascript',
    createdAt: now,
    baselineScanId: 'scan-keep',
  });
  seedScan('scan-keep', 'proj-b');
  seedScan('scan-victim', 'proj-b', 'scan-keep');

  deleteScan('scan-victim');

  assert.equal(getScan('scan-victim'), undefined);
  assert.equal(getProject('proj-b')?.baselineScanId, 'scan-keep');
  assert.equal(getScan('scan-keep')?.baselineScanId, undefined);
});
