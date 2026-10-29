// 报告结论句回归（node --test 运行，`npm test` 统一驱动）
// 历史 bug：繁体/英文 HTML 报告走 localizedConclusion，只有 urgent>0 一个分支，
// 丢掉了中文实现里的「无严重/高危」那句；中文与三语拼装两套实现因此长期漂移。
// 现在只有一份 composeConclusion：这里同时锁住「中文文案逐字不变」与「三种语言分支齐全」。
// DATA_DIR 必须在动态导入之前指向临时目录：report.ts 值导入 db.ts，静态 import 会打开并迁移
// server/data/ 里的真实库（单测绝不能碰开发者数据）。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-report-'));
process.env.DATA_DIR = tempDataDir;

const { buildReportData, renderReportHtml } = await import('../src/report.ts');
const { closeDatabase } = await import('../src/db.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

const SCAN = {
  id: 'scan-1',
  projectId: 'p-1',
  status: 'completed',
  issueCount: 2,
  scannedAt: '2026-10-29T00:00:00.000Z',
  startedAt: '2026-10-29T00:00:00.000Z',
  finishedAt: '2026-10-29T00:00:30.000Z',
  fileCount: 3,
  rules: 'builtin-python',
};

const PROJECT = {
  id: 'p-1',
  name: 'demo-repo',
  language: 'python',
  createdAt: '2026-10-29T00:00:00.000Z',
};

function issue(id, severity) {
  return {
    id,
    scanId: SCAN.id,
    fingerprint: `fp-${id}`,
    severity,
    comparisonStatus: 'remaining',
    ruleId: `python.demo-${id}`,
    message: `finding ${id}`,
    filePath: `src/${id}.py`,
    startLine: 1,
    endLine: 2,
  };
}

function render(issues, lang) {
  const data = buildReportData(SCAN, PROJECT, issues, '1.33.0');
  return { data, html: renderReportHtml(data, issues, { includeSnippets: false }, lang) };
}

test('无严重/高危时，中文结论逐字不变', () => {
  const { data } = render([issue('m', 'medium'), issue('l', 'low')], 'zh');
  assert.equal(
    data.conclusion,
    '本次扫描共检查 3 个源码文件，发现 2 个风险问题（中危 1 项、低危 1 项）。'
      + '当前无严重/高危问题，建议按业务优先级安排中低危问题的修复。',
  );
});

test('三语 HTML 报告都带「无严重/高危」那句，繁体/英文不夹简体原文', () => {
  const issues = [issue('m', 'medium'), issue('l', 'low')];
  const cases = [
    ['zh', '当前无严重/高危问题，建议按业务优先级安排中低危问题的修复。'],
    ['zh-Hant', '目前無嚴重/高危問題，建議依業務優先度安排中低危問題的修復。'],
    ['en', 'No critical or high issues remain; schedule medium and low fixes by business priority.'],
  ];
  for (const [lang, expected] of cases) {
    const { html } = render(issues, lang);
    assert.ok(html.includes(expected), `${lang} 缺少无严重/高危结论句`);
    if (lang !== 'zh') {
      assert.ok(!html.includes('建议优先处理'), `${lang} 混入简体兜底文案`);
    }
  }
});

test('有严重/高危时，三语都给优先级提示', () => {
  const issues = [issue('c', 'critical'), issue('l', 'low')];
  const cases = [
    ['zh', '建议优先处理严重与高危问题（共 1 项），修复后重新扫描回归验证。'],
    ['zh-Hant', '建議優先處理嚴重與高危問題（共 1 項），修復後重新掃描回歸驗證。'],
    ['en', 'Prioritize critical and high issues (1 in total), then rescan to verify.'],
  ];
  for (const [lang, expected] of cases) {
    const { html } = render(issues, lang);
    assert.ok(html.includes(expected), `${lang} 缺少优先级提示句`);
  }
});

test('零命中结论句按语言渲染', () => {
  const { data, html } = render([], 'en');
  assert.equal(data.totals.total, 0);
  assert.equal(data.conclusionCode?.code, 'noIssues');
  assert.ok(
    html.includes('This scan checked 3 source files, matched no enabled rules, and found no risk issues.'),
    'en 零命中结论句缺失',
  );
});
