import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-stale-scan-');

const { insertProject, insertScan, updateScan, getScan, closeDatabase } = await import('../src/db.ts');
const { markStaleScansFailed } = await import('../src/scan-runner.ts');
trackTempDir(tempDataDir, closeDatabase);

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

function seedScanning(id, { startedAt, queuedAt, dequeuedAt, scannedAt }) {
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
  if (dequeuedAt) updateScan(id, { dequeuedAt });
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
  assert.ok(orphan.finishedAt, '失败记录要有结束时间');
});

test('长时间排队的扫描不被启动清理误杀（另一实例可能只是队列深、排得久）', () => {
  seedScanning('scan-queued-long', { queuedAt: hoursAgo(3), scannedAt: hoursAgo(3) });
  markStaleScansFailed();
  assert.equal(
    getScan('scan-queued-long').status,
    'scanning',
    '排队等待可以合法超过超时+宽限（2 槽位 × 硬超时），不能按时间判死',
  );
});

test('已出队进入准备阶段的扫描不被启动清理误杀（出队时刻要晚于含排队等待的发起时间）', () => {
  seedScanning('scan-dequeued-fresh', { dequeuedAt: new Date().toISOString(), scannedAt: hoursAgo(3) });
  markStaleScansFailed();
  assert.equal(
    getScan('scan-dequeued-fresh').status,
    'scanning',
    '发起时间含排队等待，出队后的准备窗口要按出队时间判，不能按发起时间判死',
  );
});

test('出队后长时间停在准备阶段的真残骸仍被清理', () => {
  seedScanning('scan-dequeued-orphan', { dequeuedAt: hoursAgo(3), scannedAt: hoursAgo(3) });
  markStaleScansFailed();
  const orphan = getScan('scan-dequeued-orphan');
  assert.equal(orphan.status, 'failed');
  assert.equal(orphan.errorCode, 'scan.interrupted');
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
