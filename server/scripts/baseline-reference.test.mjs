import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-baseline-');

const { deleteScan, insertProject, insertScan, getProject, getScan, closeDatabase } =
  await import('../src/db.ts');
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
