import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-report-');

const { buildReportData, renderReportHtml } = await import('../src/report.ts');
const { closeDatabase } = await import('../src/db.ts');
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

test('五语 HTML 报告都带「无严重/高危」那句，非简体不夹简体原文', () => {
  const issues = [issue('m', 'medium'), issue('l', 'low')];
  const cases = [
    ['zh', '当前无严重/高危问题，建议按业务优先级安排中低危问题的修复。'],
    ['zh-Hant', '目前無嚴重/高危問題，建議依業務優先度安排中低危問題的修復。'],
    ['en', 'No critical or high issues remain; schedule medium and low fixes by business priority.'],
    ['ja', '現在、重大/高の問題はないため、ビジネスの優先度に応じて中・低の問題の修正を進めてください。'],
    ['ko', '현재 심각/높음 문제가 없으므로, 비즈니스 우선순위에 따라 중간·낮음 문제의 수정을 진행하세요.'],
  ];
  for (const [lang, expected] of cases) {
    const { html } = render(issues, lang);
    assert.ok(html.includes(expected), `${lang} 缺少无严重/高危结论句`);
    if (lang !== 'zh') {
      assert.ok(!html.includes('建议优先处理'), `${lang} 混入简体兜底文案`);
    }
  }
});

test('有严重/高危时，五语都给优先级提示', () => {
  const issues = [issue('c', 'critical'), issue('l', 'low')];
  const cases = [
    ['zh', '建议优先处理严重与高危问题（共 1 项），修复后重新扫描回归验证。'],
    ['zh-Hant', '建議優先處理嚴重與高危問題（共 1 項），修復後重新掃描回歸驗證。'],
    ['en', 'Prioritize critical and high issues (1 in total), then rescan to verify.'],
    ['ja', '重大・高の問題（合計 1 件）を優先的に修正し、修正後は再スキャンで回帰確認を行ってください。'],
    ['ko', '심각·높음 문제(총 1건)를 우선적으로 수정하고, 수정 후에는 재스캔으로 회귀 여부를 확인하세요.'],
  ];
  for (const [lang, expected] of cases) {
    const { html } = render(issues, lang);
    assert.ok(html.includes(expected), `${lang} 缺少优先级提示句`);
  }
});

test('零命中结论句按语言渲染', () => {
  const cases = [
    ['zh', 'zh-CN', '本次扫描共检查 3 个源码文件，未命中任何已启用规则，未发现风险问题。'],
    ['zh-Hant', 'zh-Hant', '本次掃描共檢查 3 個原始碼檔案，未命中任何已啟用規則，未發現風險問題。'],
    ['en', 'en', 'This scan checked 3 source files, matched no enabled rules, and found no risk issues.'],
    ['ja', 'ja', '今回のスキャンでは合計 3 件のソースファイルを検査しましたが、有効なルールには一切ヒットせず、リスクとなる問題は検出されませんでした。'],
    ['ko', 'ko', '이번 스캔에서 총 3개의 소스 파일을 검사했지만, 활성화된 규칙에는 하나도 적중하지 않았고 위험 문제는 발견되지 않았습니다.'],
  ];
  for (const [lang, htmlLang, expected] of cases) {
    const { data, html } = render([], lang);
    assert.equal(data.totals.total, 0);
    assert.equal(data.conclusionCode?.code, 'noIssues');
    assert.ok(html.includes(expected), `${lang} 零命中结论句缺失`);
    assert.ok(html.includes(`<html lang="${htmlLang}">`), `${lang} html lang 属性不符`);
  }
});

test('HTML 明细带人工复核标签（复核需按 issue.id 回填到原始行）', () => {
  const issues = [issue('c', 'critical')];
  const reviews = [
    {
      projectId: 'p-1',
      fingerprint: 'fp-c',
      status: 'confirmed',
      reason: '真实漏洞',
      reviewer: 'admin',
      updatedAt: '2026-10-29T00:00:00.000Z',
    },
  ];
  const data = buildReportData(SCAN, PROJECT, issues, '1.33.0', reviews);
  const html = renderReportHtml(data, issues, { includeSnippets: false }, 'zh');
  assert.ok(html.includes('tag-review'), '明细缺少复核标签');
  assert.ok(html.includes('已确认'), '复核标签文案缺失');
});
