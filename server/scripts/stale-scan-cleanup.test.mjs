// scanning 状态清理与失败错误码落库回归（node --test 运行，`npm test` 统一驱动）
// 历史 bug：启动清理无判据地把所有 status='scanning' 打成失败，而 dev.mjs 明确允许第二个实例
// 共用同一数据目录（AI 改代码时起项目不能杀正在用的实例）——另一实例正在跑的扫描会被误杀。
// 顺带锁住 error_code/error_params 的落库回读：前端按界面语言翻译失败原因全靠这两列。
// DATA_DIR 必须在动态导入 config/db 之前指向临时目录，单测不碰 server/data/ 的真实库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-stale-scan-'));
process.env.DATA_DIR = tempDataDir;

const { insertProject, insertScan, updateScan, getScan, closeDatabase } = await import('../src/db.ts');
const { markStaleScansFailed } = await import('../src/scan-runner.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function seedScanning(id, { startedAt, queuedAt, scannedAt }) {
  insertProject({ id: `proj-${id}`, name: id, language: 'python', createdAt: scannedAt });
  insertScan({
    id,
    projectId: `proj-${id}`,
    status: 'scanning',
    issueCount: 0,
    scannedAt,
    fileCount: 0,
  });
  if (queuedAt) updateScan(id, { queuedAt });
  if (startedAt) updateScan(id, { startedAt });
}

test('未超过引擎超时的 scanning 记录不被启动清理误杀（另一实例可能正在跑）', () => {
  seedScanning('scan-running-fresh', { startedAt: new Date().toISOString(), scannedAt: hoursAgo(0) });
  seedScanning('scan-queued-fresh', { queuedAt: new Date().toISOString(), scannedAt: hoursAgo(0) });
  markStaleScansFailed();
  assert.equal(getScan('scan-running-fresh').status, 'scanning', '刚开跑的扫描被误判为中断');
  assert.equal(getScan('scan-queued-fresh').status, 'scanning', '刚排队的扫描被误判为中断');
});

test('超过引擎超时仍在 scanning 的残骸被标记失败并带上可翻译的错误码', () => {
  seedScanning('scan-orphan', { startedAt: hoursAgo(3), scannedAt: hoursAgo(3) });
  markStaleScansFailed();
  const orphan = getScan('scan-orphan');
  assert.equal(orphan.status, 'failed');
  assert.equal(orphan.errorCode, 'scan.interrupted');
  assert.equal(orphan.queuedAt, undefined, '排队标记必须随失败一并清除');
  assert.ok(orphan.finishedAt, '失败记录要有结束时间');
});

test('失败错误码与插值参数落库后可原样回读', () => {
  seedScanning('scan-failed', { startedAt: hoursAgo(1), scannedAt: hoursAgo(1) });
  updateScan('scan-failed', {
    status: 'failed',
    message: '扫描超过 10 分钟被终止，请缩小源码范围后重试',
    errorCode: 'scan.timedOut',
    errorParams: { minutes: 10 },
  });
  const scan = getScan('scan-failed');
  assert.equal(scan.errorCode, 'scan.timedOut');
  assert.deepEqual(scan.errorParams, { minutes: 10 });
});

test('未带 code 的意外失败只留中文兜底文案，回读不产生空对象', () => {
  seedScanning('scan-plain-error', { startedAt: hoursAgo(1), scannedAt: hoursAgo(1) });
  updateScan('scan-plain-error', { status: 'failed', message: '引擎二进制不存在' });
  const scan = getScan('scan-plain-error');
  assert.equal(scan.errorCode, undefined);
  assert.equal(scan.errorParams, undefined);
});
