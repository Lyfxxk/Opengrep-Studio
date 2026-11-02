import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-risk-summary-');

const {
  getRiskSummary,
  insertProject,
  insertScan,
  replaceIssues,
  upsertReview,
  closeDatabase,
} = await import('../src/db.ts');
trackTempDir(tempDataDir, closeDatabase);

function makeProject(id, createdAt) {
  insertProject({ id, name: `项目 ${id}`, language: '', createdAt });
}

function makeScan(projectId, id, status, scannedAt) {
  insertScan({
    id,
    projectId,
    status,
    issueCount: 0,
    scannedAt,
    fileCount: 0,
  });
}

function makeIssue(scanId, fingerprint, ruleId, severity, comparisonStatus = 'remaining') {
  return {
    id: '',
    scanId,
    fingerprint,
    ruleId,
    severity,
    message: ruleId,
    filePath: 'src/a.js',
    startLine: 1,
    endLine: 1,
    comparisonStatus,
  };
}

function seedIssues(scanId, issues) {
  replaceIssues(scanId, issues);
}

function review(projectId, fingerprint, status) {
  upsertReview({ projectId, fingerprint, status, updatedAt: '2026-11-01T00:00:00.000Z' });
}

test('空库返回全零且不抛错', () => {
  const summary = getRiskSummary();
  assert.deepEqual(summary.projects, []);
  assert.deepEqual(summary.severityCounts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.deepEqual(summary.topRules, []);
  assert.equal(summary.pendingReview, 0);
  assert.equal(summary.total, 0);
});

test('每个项目取最新的已完成扫描，未完成扫描与旧扫描忽略', () => {
  makeProject('p-newest', '2026-01-01T00:00:00.000Z');
  makeScan('p-newest', 's-old', 'completed', '2026-01-02T00:00:00.000Z');
  makeScan('p-newest', 's-scanning', 'scanning', '2026-01-04T00:00:00.000Z');
  makeScan('p-newest', 's-failed', 'failed', '2026-01-04T00:00:00.000Z');
  makeScan('p-newest', 's-latest', 'completed', '2026-01-03T00:00:00.000Z');
  seedIssues('s-old', [makeIssue('s-old', 'f-old', 'rule.old', 'critical')]);
  seedIssues('s-latest', [makeIssue('s-latest', 'f-new', 'rule.new', 'high')]);
  seedIssues('s-scanning', [makeIssue('s-scanning', 'f-run', 'rule.running', 'critical')]);

  const summary = getRiskSummary();
  const project = summary.projects.find((item) => item.projectId === 'p-newest');
  assert.equal(project.latestScanId, 's-latest');
  assert.equal(project.total, 1);
  assert.equal(project.critical, 0);
  assert.equal(project.high, 1);
  assert.equal(
    summary.topRules.some((rule) => rule.ruleId === 'rule.running'),
    false,
  );
  assert.equal(
    summary.topRules.some((rule) => rule.ruleId === 'rule.old'),
    false,
  );
});

test('scanned_at 并列时取 id 较大的扫描', () => {
  makeProject('p-tie', '2026-01-01T00:00:00.000Z');
  makeScan('p-tie', 's-a', 'completed', '2026-02-01T00:00:00.000Z');
  makeScan('p-tie', 's-b', 'completed', '2026-02-01T00:00:00.000Z');
  seedIssues('s-a', [makeIssue('s-a', 'f-a', 'rule.fromA', 'low')]);
  seedIssues('s-b', [makeIssue('s-b', 'f-b', 'rule.fromB', 'low')]);

  const summary = getRiskSummary();
  const project = summary.projects.find((item) => item.projectId === 'p-tie');
  assert.equal(project.latestScanId, 's-b');
  assert.equal(
    summary.topRules.some((rule) => rule.ruleId === 'rule.fromA'),
    false,
  );
});

test('fixed 问题不计入，但仅有 fixed 的项目仍以 0 出现', () => {
  makeProject('p-fixed', '2026-01-01T00:00:00.000Z');
  makeProject('p-fixed-only', '2026-01-01T00:00:00.000Z');
  makeScan('p-fixed', 's-mixed', 'completed', '2026-03-01T00:00:00.000Z');
  makeScan('p-fixed-only', 's-all-fixed', 'completed', '2026-03-01T00:00:00.000Z');
  seedIssues('s-mixed', [
    makeIssue('s-mixed', 'f-live', 'rule.live', 'critical'),
    makeIssue('s-mixed', 'f-gone', 'rule.gone', 'critical', 'fixed'),
  ]);
  seedIssues('s-all-fixed', [
    makeIssue('s-all-fixed', 'f-gone-1', 'rule.gone', 'high', 'fixed'),
    makeIssue('s-all-fixed', 'f-gone-2', 'rule.gone', 'high', 'fixed'),
  ]);

  const summary = getRiskSummary();
  const mixed = summary.projects.find((item) => item.projectId === 'p-fixed');
  assert.equal(mixed.total, 1);
  assert.equal(mixed.critical, 1);
  const allFixed = summary.projects.find((item) => item.projectId === 'p-fixed-only');
  assert.equal(allFixed.total, 0);
  assert.equal(allFixed.high, 0);
  assert.equal(allFixed.latestScanId, 's-all-fixed');
  assert.equal(
    summary.topRules.some((rule) => rule.ruleId === 'rule.gone'),
    false,
  );
});

test('未扫描项目出现在列表里且不带 latestScanId', () => {
  makeProject('p-unscanned', '2026-01-01T00:00:00.000Z');
  const summary = getRiskSummary();
  const project = summary.projects.find((item) => item.projectId === 'p-unscanned');
  assert.ok(project);
  assert.equal('latestScanId' in project, false);
  assert.equal(project.total, 0);
});

test('待复核数：无复核记录与显式 pending 都算待复核，已定论的不算', () => {
  makeProject('p-review', '2026-01-01T00:00:00.000Z');
  makeScan('p-review', 's-review', 'completed', '2026-04-01T00:00:00.000Z');
  seedIssues('s-review', [
    makeIssue('s-review', 'f-none', 'rule.rev', 'low'),
    makeIssue('s-review', 'f-pending', 'rule.rev', 'low'),
    makeIssue('s-review', 'f-confirmed', 'rule.rev', 'low'),
    makeIssue('s-review', 'f-fp', 'rule.rev', 'low'),
  ]);

  const baseline = getRiskSummary().pendingReview;
  assert.equal(getRiskSummary().projects.find((item) => item.projectId === 'p-review').total, 4);

  review('p-review', 'f-pending', 'pending');
  assert.equal(getRiskSummary().pendingReview - baseline, 0);

  review('p-review', 'f-confirmed', 'confirmed');
  assert.equal(getRiskSummary().pendingReview - baseline, -1);

  review('p-review', 'f-fp', 'false_positive');
  assert.equal(getRiskSummary().pendingReview - baseline, -2);

  const entry = getRiskSummary().topRules.find((rule) => rule.ruleId === 'rule.rev');
  assert.equal(entry.count, 4);
});

test('复核按项目隔离，其他项目同指纹不算已复核', () => {
  makeProject('p-iso-a', '2026-01-01T00:00:00.000Z');
  makeProject('p-iso-b', '2026-01-01T00:00:00.000Z');
  makeScan('p-iso-a', 's-iso-a', 'completed', '2026-05-01T00:00:00.000Z');
  makeScan('p-iso-b', 's-iso-b', 'completed', '2026-05-01T00:00:00.000Z');
  seedIssues('s-iso-a', [makeIssue('s-iso-a', 'f-shared', 'rule.iso', 'medium')]);
  seedIssues('s-iso-b', [makeIssue('s-iso-b', 'f-shared', 'rule.iso', 'medium')]);

  const baseline = getRiskSummary().pendingReview;

  review('p-iso-b', 'f-shared', 'confirmed');
  assert.equal(getRiskSummary().pendingReview, baseline - 1);

  review('p-iso-a', 'f-shared', 'accepted');
  assert.equal(getRiskSummary().pendingReview, baseline - 2);
});

test('全局直方图等于各项目之和，总数一致', () => {
  const summary = getRiskSummary();
  const sumProjects = summary.projects.reduce((acc, project) => acc + project.total, 0);
  const sumSeverity = Object.values(summary.severityCounts).reduce((acc, count) => acc + count, 0);
  assert.equal(summary.total, sumProjects);
  assert.equal(summary.total, sumSeverity);
  for (const project of summary.projects) {
    assert.equal(
      project.critical + project.high <= project.total,
      true,
      `项目 ${project.projectId} 的 critical+high 不应超过总数`,
    );
  }
});

test('同一规则跨严重度出现时取最严重的一档并累加计数', () => {
  makeProject('p-multi', '2026-01-01T00:00:00.000Z');
  makeScan('p-multi', 's-multi', 'completed', '2026-07-01T00:00:00.000Z');
  seedIssues('s-multi', [
    makeIssue('s-multi', 'f-m-low', 'rule.multi', 'low'),
    makeIssue('s-multi', 'f-m-crit', 'rule.multi', 'critical'),
  ]);

  const entry = getRiskSummary().topRules.find((rule) => rule.ruleId === 'rule.multi');
  assert.ok(entry);
  assert.equal(entry.severity, 'critical');
  assert.equal(entry.count, 2);
});

test('topRules 按数量降序、严重度升序、ruleId 升序并截断到 6 条', () => {
  makeProject('p-sort', '2026-01-01T00:00:00.000Z');
  makeScan('p-sort', 's-sort', 'completed', '2026-06-01T00:00:00.000Z');
  const issues = [];
  const push = (ruleId, severity, count) => {
    for (let i = 0; i < count; i += 1) {
      issues.push(makeIssue('s-sort', `f-${ruleId}-${i}`, ruleId, severity));
    }
  };
  push('sort-crit', 'critical', 100);
  push('sort-high', 'high', 100);
  push('sort-low-b', 'low', 99);
  push('sort-low-a', 'low', 99);
  push('sort-98', 'medium', 98);
  push('sort-97', 'medium', 97);
  push('sort-96', 'medium', 96);
  seedIssues('s-sort', issues);

  const summary = getRiskSummary();
  assert.equal(summary.topRules.length, 6);
  assert.deepEqual(
    summary.topRules.map((rule) => rule.ruleId),
    ['sort-crit', 'sort-high', 'sort-low-a', 'sort-low-b', 'sort-98', 'sort-97'],
  );
  assert.equal(
    summary.topRules.some((rule) => rule.ruleId === 'sort-96'),
    false,
  );
  assert.deepEqual(
    summary.topRules.map((rule) => rule.severity),
    ['critical', 'high', 'low', 'low', 'medium', 'medium'],
  );
});
