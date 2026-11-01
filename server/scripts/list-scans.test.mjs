import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-list-scans-'));
process.env.DATA_DIR = tempDataDir;

const { insertProject, insertScan, listAllScans, closeDatabase } = await import('../src/db.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

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
