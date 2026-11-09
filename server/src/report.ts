import { isActiveIssue, SEVERITY_RANK } from './db.js';
import type {
  ComparisonStatus,
  Issue,
  IssueRow,
  Project,
  Review,
  ReviewStatus,
  RulePackRef,
  ScanRecord,
  Severity,
} from './db.js';

interface ReportMeta {
  projectId: string;
  projectName: string;
  projectDescription?: string;
  language: string;
  scanId: string;
  scannedAt: string;
  finishedAt?: string;
  durationSeconds?: number;
  fileCount: number;
  baselineScanId?: string;
  rulepacks?: RulePackRef[];
  rules?: string;
  importSource?: string;
  toolName?: string;
  engineVersion?: string;
  sourceHash?: string;
  commandLine?: string;
  generatedAt: string;
}

interface ReportTotals {
  total: number;
  bySeverity: Record<Severity, number>;
  byComparison: Record<ComparisonStatus, number>;
}

interface ReportFileAgg {
  filePath: string;
  count: number;
  maxSeverity: Severity;
  topRule?: string;
}

interface ReportReviewSummary {
  reviewed: number;
  confirmed: number;
  falsePositives: number;
  accepted: number;
}

interface ReportIssueReview {
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt?: string;
}

export interface ConclusionPayload {
  code: string;
  params: Record<string, unknown>;
  message: string;
}

export interface ReportData {
  meta: ReportMeta;
  totals: ReportTotals;
  conclusion: string;
  conclusionCode?: ConclusionPayload | null;
  topFiles: ReportFileAgg[];
  issues: Array<Issue & { review?: ReportIssueReview }>;
  reviewStats?: ReportReviewSummary;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL: Record<Severity, string> = { critical: '严重', high: '高危', medium: '中危', low: '低危' };
const COMPARISON_LABEL: Record<ComparisonStatus, string> = {
  new: '新增',
  fixed: '已修复',
  remaining: '遗留',
};
const REVIEW_LABEL: Record<ReviewStatus, string> = {
  pending: '待复核',
  confirmed: '已确认',
  false_positive: '误报',
  accepted: '已接受',
};

export type ReportLang = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'ru' | 'fr' | 'de';

const HANT_SEVERITY: Record<Severity, string> = {
  critical: '嚴重',
  high: '高危',
  medium: '中危',
  low: '低危',
};
const HANT_COMPARISON: Record<ComparisonStatus, string> = {
  new: '新增',
  fixed: '已修復',
  remaining: '遺留',
};
const HANT_REVIEW: Record<ReviewStatus, string> = {
  pending: '待複核',
  confirmed: '已確認',
  false_positive: '誤報',
  accepted: '已接受',
};

const REPORT_TEXT_ZH = {
  htmlLang: 'zh-CN',
  brand: 'Opengrep Studio · 码审工作台',
  docTitle: '代码审计测试报告',
  severity: SEVERITY_LABEL,
  comparison: COMPARISON_LABEL,
  review: REVIEW_LABEL,
  sections: {
    actions: '行动清单 · 按文件',
    details: '问题明细',
    method: '方法与证据',
    rulesAppendix: '附录 · 规则说明',
  },
  meta: {
    engine: '扫描引擎',
    sourceHash: '源码哈希',
    commandLine: '引擎命令行',
    generatedAt: '报告生成时间',
    finishedAt: '完成时间',
    rulesLabel: '规则',
  },
  metrics: { total: '风险总数', critical: '严重', high: '高危', files: '涉及文件' },
  distTitle: '风险分布',
  top5Title: '问题最多的 5 个文件',
  top5Hint: '按条数排序，不代表风险优先级；风险优先级见「行动清单」。',
  thFile: '文件',
  thCount: '合计',
  thMaxSeverity: '最高等级',
  scopeLabel: '检查范围',
  baselineLabel: '基线对比',
  distLabel: '问题分布',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} 条问题落在 ${files} 个文件、${rules} 条规则上`,
  firstScanNoBaseline: '首次扫描，无基线可比',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `对比基线 ${id}：新增 ${added} · 遗留 ${remaining} · 已修复 ${fixed}`,
  actionsHint: (files: number) =>
    `共 ${files} 个文件，排序为「最高等级优先，同级按问题数降序」。建议自上而下安排修复。`,
  thFileMainIssue: '文件 / 主要问题',
  groupCount: (count: number, files: number) => `${count} 条 · ${files} 个文件`,
  groupHint: {
    critical: '可直接导致远程代码执行或凭据泄露，建议立即修复并单独出具说明。',
    high: '位于常见攻击路径上，建议本迭代内修复。',
    medium: '需特定前置条件或影响有限，建议纳入下个迭代的技术债清单。',
    low: '编码规范与可维护性问题，随日常改动顺手修即可。',
  },
  fixedHeading: (count: number) => `已修复（对比基线，${count} 项）`,
  appendixHint: (rules: number) =>
    `${rules} 条规则按最高严重度排序，同级别内按命中次数排列；同一规则的完整说明（含修复建议）只在此处出现一次。`,
  ruleStat: (count: number, files: number) => `命中 ${count} 次 · ${files} 个文件`,
  noMessage: '（暂无说明）',
  noDescription: '（结果未提供描述）',
  unknownPath: '（未知路径）',
  methodSub: { packs: '规则集', repro: '引擎与可复现性', review: '复核与覆盖', exclusions: '排除项', boundaries: '覆盖边界' },
  packThName: '规则包',
  packThId: '标识',
  noPacks: '未记录规则包',
  sarifImport: (tool?: string) => (tool ? `SARIF 导入（${tool}）` : 'SARIF 导入'),
  filesChecked: '扫描文件',
  filesUnit: (n: number) => `${n} 个`,
  issuesUnit: (n: number) => `${n} 条`,
  durationSeconds: (s: number) => `${s} 秒`,
  durationMinutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
  exclusions: '遵循项目 .gitignore；跳过 node_modules 与 .git',
  notCovered: '本报告只反映已加载规则的命中结果，不代表不存在其他缺陷',
  reviewLabel: '人工复核',
  reviewLine: (s: ReportReviewSummary) =>
    `已复核 ${s.reviewed} 条：确认 ${s.confirmed} · 误报 ${s.falsePositives} · 已接受 ${s.accepted}。`,
  reviewNone: '本次扫描未进行人工复核，全部问题为引擎原始判定结果。',
  noIssues: '本次扫描未发现风险问题。',
  snippetOverflow: (limit: number) =>
    `代码片段超过上限，仅展示前 ${limit} 条，其余请结合扫描结果页查看。`,
  footer: (time: string) =>
    `本报告由 Opengrep Studio 码审工作台自动生成 · 生成时间 ${time} · 规则命中与严重度由 opengrep 引擎产出，请结合业务上下文人工复核。`,
  listSeparator: '、',
  sentenceSeparator: '',
  severityPhrase: (label: string, count: number) => `${label} ${count} 项`,
  conclusionNoIssues: (files: string) =>
    `本次扫描共检查 ${files} 个源码文件，未命中任何已启用规则，未发现风险问题。`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `本次扫描共检查 ${files} 个源码文件，发现 ${total} 个风险问题（${sevText}）。`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `与基线扫描 ${baseline} 相比：新增 ${added} 项、遗留 ${remaining} 项、已修复 ${fixed} 项。`,
  urgentHint: (urgent: number) => `建议优先处理严重与高危问题（共 ${urgent} 项），修复后重新扫描回归验证。`,
  nonUrgentHint: () => '当前无严重/高危问题，建议按业务优先级安排中低危问题的修复。',
  summaryReview: (s: ReportReviewSummary) =>
    ` 人工复核已完成 ${s.reviewed} 项（确认 ${s.confirmed}、误报 ${s.falsePositives}、有条件接受 ${s.accepted}）。`,
};

const REPORT_TEXT_HANT: typeof REPORT_TEXT_ZH = {
  htmlLang: 'zh-Hant',
  brand: 'Opengrep Studio · 碼審工作台',
  docTitle: '程式碼稽核測試報告',
  severity: HANT_SEVERITY,
  comparison: HANT_COMPARISON,
  review: HANT_REVIEW,
  sections: {
    actions: '行動清單 · 按檔案',
    details: '問題明細',
    method: '方法與證據',
    rulesAppendix: '附錄 · 規則說明',
  },
  meta: {
    engine: '掃描引擎',
    sourceHash: '原始碼雜湊',
    commandLine: '引擎命令列',
    generatedAt: '報告產生時間',
    finishedAt: '完成時間',
    rulesLabel: '規則',
  },
  metrics: { total: '風險總數', critical: '嚴重', high: '高危', files: '涉及檔案' },
  distTitle: '風險分佈',
  top5Title: '問題最多的 5 個檔案',
  top5Hint: '按條數排序，不代表風險優先級；風險優先級見「行動清單」。',
  thFile: '檔案',
  thCount: '合計',
  thMaxSeverity: '最高等級',
  scopeLabel: '檢查範圍',
  baselineLabel: '基線對比',
  distLabel: '問題分佈',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} 條問題落在 ${files} 個檔案、${rules} 條規則上`,
  firstScanNoBaseline: '首次掃描，無基線可比',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `對比基線 ${id}：新增 ${added} · 遺留 ${remaining} · 已修復 ${fixed}`,
  actionsHint: (files: number) =>
    `共 ${files} 個檔案，排序為「最高等級優先，同級按問題數降序」。建議自上而下安排修復。`,
  thFileMainIssue: '檔案 / 主要問題',
  groupCount: (count: number, files: number) => `${count} 條 · ${files} 個檔案`,
  groupHint: {
    critical: '可直接導致遠端程式碼執行或憑證洩露，建議立即修復並單獨出具說明。',
    high: '位於常見攻擊路徑上，建議本迭代內修復。',
    medium: '需特定前置條件或影響有限，建議納入下個迭代的技術債清單。',
    low: '編碼規範與可維護性問題，隨日常改動順手修即可。',
  },
  fixedHeading: (count: number) => `已修復（對比基線，${count} 項）`,
  appendixHint: (rules: number) =>
    `${rules} 條規則按最高嚴重度排序，同等級內按命中次數排列；同一規則的完整說明（含修復建議）只在此處出現一次。`,
  ruleStat: (count: number, files: number) => `命中 ${count} 次 · ${files} 個檔案`,
  noMessage: '（暫無說明）',
  noDescription: '（結果未提供描述）',
  unknownPath: '（未知路徑）',
  methodSub: { packs: '規則集', repro: '引擎與可重現性', review: '複核與覆蓋', exclusions: '排除項', boundaries: '覆蓋邊界' },
  packThName: '規則包',
  packThId: '標識',
  noPacks: '未記錄規則包',
  sarifImport: (tool?: string) => (tool ? `SARIF 匯入（${tool}）` : 'SARIF 匯入'),
  filesChecked: '掃描檔案',
  filesUnit: (n: number) => `${n} 個`,
  issuesUnit: (n: number) => `${n} 條`,
  durationSeconds: (s: number) => `${s} 秒`,
  durationMinutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
  exclusions: '遵循專案 .gitignore；跳過 node_modules 與 .git',
  notCovered: '本報告只反映已載入規則的命中結果，不代表不存在其他缺陷',
  reviewLabel: '人工複核',
  reviewLine: (s: ReportReviewSummary) =>
    `已複核 ${s.reviewed} 條：確認 ${s.confirmed} · 誤報 ${s.falsePositives} · 已接受 ${s.accepted}。`,
  reviewNone: '本次掃描未進行人工複核，全部問題為引擎原始判定結果。',
  noIssues: '本次掃描未發現風險問題。',
  snippetOverflow: (limit: number) =>
    `程式碼片段超過上限，僅展示前 ${limit} 條，其餘請結合掃描結果頁查看。`,
  footer: (time: string) =>
    `本報告由 Opengrep Studio 碼審工作台自動產生 · 產生時間 ${time} · 規則命中與嚴重度由 opengrep 引擎產出，請結合業務上下文人工複核。`,
  listSeparator: '、',
  sentenceSeparator: '',
  severityPhrase: (label: string, count: number) => `${label} ${count} 項`,
  conclusionNoIssues: (files: string) =>
    `本次掃描共檢查 ${files} 個原始碼檔案，未命中任何已啟用規則，未發現風險問題。`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `本次掃描共檢查 ${files} 個原始碼檔案，發現 ${total} 個風險問題（${sevText}）。`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `與基線掃描 ${baseline} 相比：新增 ${added} 項、遺留 ${remaining} 項、已修復 ${fixed} 項。`,
  urgentHint: (urgent: number) => `建議優先處理嚴重與高危問題（共 ${urgent} 項），修復後重新掃描回歸驗證。`,
  nonUrgentHint: () => '目前無嚴重/高危問題，建議依業務優先度安排中低危問題的修復。',
  summaryReview: (s: ReportReviewSummary) =>
    ` 人工複核已完成 ${s.reviewed} 項（確認 ${s.confirmed}、誤報 ${s.falsePositives}、有條件接受 ${s.accepted}）。`,
};

const EN_SEVERITY: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const EN_COMPARISON: Record<ComparisonStatus, string> = {
  new: 'New',
  fixed: 'Fixed',
  remaining: 'Remaining',
};
const EN_REVIEW: Record<ReviewStatus, string> = {
  pending: 'Pending review',
  confirmed: 'Confirmed',
  false_positive: 'False positive',
  accepted: 'Accepted',
};

const REPORT_TEXT_EN: typeof REPORT_TEXT_ZH = {
  htmlLang: 'en',
  brand: 'Opengrep Studio · Code Audit Workbench',
  docTitle: 'Code Audit Test Report',
  severity: EN_SEVERITY,
  comparison: EN_COMPARISON,
  review: EN_REVIEW,
  sections: {
    actions: 'Action list · by file',
    details: 'Issue details',
    method: 'Method & evidence',
    rulesAppendix: 'Appendix · Rule notes',
  },
  meta: {
    engine: 'Scan engine',
    sourceHash: 'Source SHA-256',
    commandLine: 'Engine command line',
    generatedAt: 'Report generated at',
    finishedAt: 'Finished at',
    rulesLabel: 'Rules',
  },
  metrics: { total: 'Total issues', critical: 'Critical', high: 'High', files: 'Files involved' },
  distTitle: 'Risk distribution',
  top5Title: 'Top 5 files by issue count',
  top5Hint: 'Sorted by count — this is not a risk priority; see the action list for priority.',
  thFile: 'File',
  thCount: 'Total',
  thMaxSeverity: 'Max severity',
  scopeLabel: 'Scope',
  baselineLabel: 'Baseline',
  distLabel: 'Distribution',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} issues across ${files} files and ${rules} rules`,
  firstScanNoBaseline: 'First scan — no baseline to compare',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `vs baseline ${id}: ${added} new · ${remaining} remaining · ${fixed} fixed`,
  actionsHint: (files: number) =>
    `${files} files, sorted by max severity then issue count. Work top-down.`,
  thFileMainIssue: 'File / main issue',
  groupCount: (count: number, files: number) => `${count} issues · ${files} files`,
  groupHint: {
    critical: 'Can directly lead to remote code execution or credential leaks. Fix immediately and document separately.',
    high: 'On common attack paths; fix within this iteration.',
    medium: 'Requires specific preconditions or has limited impact; schedule as tech debt.',
    low: 'Coding-style and maintainability issues; fix opportunistically.',
  },
  fixedHeading: (count: number) => `Fixed (vs baseline, ${count})`,
  appendixHint: (rules: number) =>
    `${rules} rules sorted by max severity, then hit count; the full note (with fix guidance) appears here only once per rule.`,
  ruleStat: (count: number, files: number) => `${count} hits · ${files} files`,
  noMessage: '(no note available)',
  noDescription: '(no description provided)',
  unknownPath: '(unknown path)',
  methodSub: { packs: 'Rule packs', repro: 'Engine & reproducibility', review: 'Review & coverage', exclusions: 'Exclusions', boundaries: 'Coverage boundary' },
  packThName: 'Rule pack',
  packThId: 'ID',
  noPacks: 'No rule packs recorded',
  sarifImport: (tool?: string) => (tool ? `SARIF import (${tool})` : 'SARIF import'),
  filesChecked: 'Files scanned',
  filesUnit: (n: number) => `${n} files`,
  issuesUnit: (n: number) => (n === 1 ? '1 issue' : `${n} issues`),
  durationSeconds: (s: number) => `${s}s`,
  durationMinutes: (m: number, s: number) => `${m}m ${s}s`,
  exclusions: "Respects the project's .gitignore; skips node_modules and .git",
  notCovered: 'This report only reflects hits from the loaded rules; absence of findings is not proof of absence of defects.',
  reviewLabel: 'Manual review',
  reviewLine: (s: ReportReviewSummary) =>
    `${s.reviewed} reviewed: ${s.confirmed} confirmed · ${s.falsePositives} false positive · ${s.accepted} accepted.`,
  reviewNone: 'No manual review was performed; all findings are raw engine verdicts.',
  noIssues: 'No risk issues were found in this scan.',
  snippetOverflow: (limit: number) =>
    `Snippet limit reached — showing the first ${limit}; open the scan result page for the rest.`,
  footer: (time: string) =>
    `Generated by Opengrep Studio · ${time} · Rule hits and severities come from the opengrep engine; review them in business context.`,
  listSeparator: ', ',
  sentenceSeparator: ' ',
  severityPhrase: (label: string, count: number) => `${label} ${count}`,
  conclusionNoIssues: (files: string) =>
    `This scan checked ${files} source files, matched no enabled rules, and found no risk issues.`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `This scan checked ${files} source files and found ${total} risk issues (${sevText}).`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `Compared with baseline scan ${baseline}: ${added} new, ${remaining} remaining, ${fixed} fixed.`,
  urgentHint: (urgent: number) =>
    `Prioritize critical and high issues (${urgent} in total), then rescan to verify.`,
  nonUrgentHint: () =>
    'No critical or high issues remain; schedule medium and low fixes by business priority.',
  summaryReview: (s: ReportReviewSummary) =>
    ` Manual review: ${s.reviewed} reviewed (${s.confirmed} confirmed, ${s.falsePositives} false positive, ${s.accepted} accepted).`,
};

const JA_SEVERITY: Record<Severity, string> = {
  critical: '重大',
  high: '高',
  medium: '中',
  low: '低',
};
const JA_COMPARISON: Record<ComparisonStatus, string> = {
  new: '新規',
  fixed: '修正済み',
  remaining: '残存',
};
const JA_REVIEW: Record<ReviewStatus, string> = {
  pending: 'レビュー待ち',
  confirmed: '確認済み',
  false_positive: '誤検知',
  accepted: '受諾済み',
};

const REPORT_TEXT_JA: typeof REPORT_TEXT_ZH = {
  htmlLang: 'ja',
  brand: 'Opengrep Studio · コード監査ワークベンチ',
  docTitle: 'コード監査テストレポート',
  severity: JA_SEVERITY,
  comparison: JA_COMPARISON,
  review: JA_REVIEW,
  sections: {
    actions: 'アクションリスト · ファイル別',
    details: '問題の詳細',
    method: '方法とエビデンス',
    rulesAppendix: '付録 · ルール説明',
  },
  meta: {
    engine: 'スキャンエンジン',
    sourceHash: 'ソースコードハッシュ',
    commandLine: 'エンジンコマンドライン',
    generatedAt: 'レポート生成日時',
    finishedAt: '完了日時',
    rulesLabel: 'ルール',
  },
  metrics: { total: 'リスク総数', critical: '重大', high: '高', files: '関連ファイル' },
  distTitle: 'リスク分布',
  top5Title: '問題数の多い上位 5 件のファイル',
  top5Hint: '件数順に並んでいます。リスクの優先度を表すものではありません。リスクの優先度は「アクションリスト」を参照してください。',
  thFile: 'ファイル',
  thCount: '合計',
  thMaxSeverity: '最大深刻度',
  scopeLabel: '検査範囲',
  baselineLabel: 'ベースライン比較',
  distLabel: '問題分布',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} 件の問題が ${files} 件のファイル、${rules} 件のルールにわたっています`,
  firstScanNoBaseline: '最初のスキャンのため、比較できるベースラインはありません',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `ベースライン ${id} との比較：新規 ${added} · 残存 ${remaining} · 修正済み ${fixed}`,
  actionsHint: (files: number) =>
    `合計 ${files} 件のファイルです。並び順は「最大深刻度を優先し、同一レベルは問題数の降順」です。上から順に修正を進めることをお勧めします。`,
  thFileMainIssue: 'ファイル / 主な問題',
  groupCount: (count: number, files: number) => `${count} 件 · ${files} 件のファイル`,
  groupHint: {
    critical: 'リモートコード実行や認証情報の漏えいに直結する可能性があります。直ちに修正し、別途で説明を作成することをお勧めします。',
    high: '一般的な攻撃パス上に位置します。今回のイテレーション内での修正をお勧めします。',
    medium: '特定の前提条件が必要か、影響が限定的です。次のイテレーションの技術的負債リストに追加することをお勧めします。',
    low: 'コーディング規約や保守性に関する問題です。日常の変更の際に随時修正すれば十分です。',
  },
  fixedHeading: (count: number) => `修正済み（ベースライン比較、${count} 件）`,
  appendixHint: (rules: number) =>
    `${rules} 件のルールを最大深刻度の高い順に（同レベル内はヒット回数順に）並べています。同一ルールの完全な説明（修正提案を含む）は、ここに一度だけ表示されます。`,
  ruleStat: (count: number, files: number) => `ヒット ${count}回 · ${files} 件のファイル`,
  noMessage: '（説明はまだありません）',
  noDescription: '（結果に説明がありません）',
  unknownPath: '（不明なパス）',
  methodSub: { packs: 'ルールセット', repro: 'エンジンと再現性', review: 'レビューとカバレッジ', exclusions: '除外項目', boundaries: 'カバレッジの境界' },
  packThName: 'ルールパック',
  packThId: 'ID',
  noPacks: '記録されたルールパックはありません',
  sarifImport: (tool?: string) => (tool ? `SARIF インポート（${tool}）` : 'SARIF インポート'),
  filesChecked: 'スキャンしたファイル',
  filesUnit: (n: number) => `${n} 件`,
  issuesUnit: (n: number) => `${n} 件`,
  durationSeconds: (s: number) => `${s} 秒`,
  durationMinutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
  exclusions: 'プロジェクトの .gitignore に従い、node_modules と .git をスキップします',
  notCovered: '本レポートは読み込み済みのルールのヒット結果のみを反映したものであり、他の欠陥が存在しないことを意味するものではありません',
  reviewLabel: '手動レビュー',
  reviewLine: (s: ReportReviewSummary) =>
    `${s.reviewed} 件をレビュー済み：確認済み ${s.confirmed} · 誤検知 ${s.falsePositives} · 受諾済み ${s.accepted}。`,
  reviewNone: '今回のスキャンでは手動レビューは行われておらず、すべての問題はエンジンの元の判定結果です。',
  noIssues: '今回のスキャンではリスクとなる問題は検出されませんでした。',
  snippetOverflow: (limit: number) =>
    `コードスニペットが上限を超えたため、先頭の ${limit} 件のみ表示しています。残りはスキャン結果ページでご確認ください。`,
  footer: (time: string) =>
    `本レポートは Opengrep Studio コード監査ワークベンチにより自動生成されました · 生成日時 ${time} · ルールのヒット結果と深刻度は opengrep エンジンが自動的に算出します。ビジネスの文脈を踏まえて手動レビューを行ってください。`,
  listSeparator: '、',
  sentenceSeparator: '',
  severityPhrase: (label: string, count: number) => `${label} ${count} 件`,
  conclusionNoIssues: (files: string) =>
    `今回のスキャンでは合計 ${files} 件のソースファイルを検査しましたが、有効なルールには一切ヒットせず、リスクとなる問題は検出されませんでした。`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `今回のスキャンでは合計 ${files} 件のソースファイルを検査し、リスクとなる問題を ${total} 件検出しました（${sevText}）。`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `ベースラインスキャン ${baseline} との比較では、新規 ${added} 件、残存 ${remaining} 件、修正済み ${fixed} 件です。`,
  urgentHint: (urgent: number) =>
    `重大・高の問題（合計 ${urgent} 件）を優先的に修正し、修正後は再スキャンで回帰確認を行ってください。`,
  nonUrgentHint: () =>
    '現在、重大/高の問題はないため、ビジネスの優先度に応じて中・低の問題の修正を進めてください。',
  summaryReview: (s: ReportReviewSummary) =>
    ` 手動レビューは ${s.reviewed} 件完了（確認済み ${s.confirmed}、誤検知 ${s.falsePositives}、条件付き受諾 ${s.accepted}）。`,
};

const KO_SEVERITY: Record<Severity, string> = {
  critical: '심각',
  high: '높음',
  medium: '중간',
  low: '낮음',
};
const KO_COMPARISON: Record<ComparisonStatus, string> = {
  new: '신규',
  fixed: '수정 완료',
  remaining: '잔존',
};
const KO_REVIEW: Record<ReviewStatus, string> = {
  pending: '검토 대기',
  confirmed: '확인됨',
  false_positive: '오탐',
  accepted: '수용됨',
};

const REPORT_TEXT_KO: typeof REPORT_TEXT_ZH = {
  htmlLang: 'ko',
  brand: 'Opengrep Studio · 코드 감사 워크벤치',
  docTitle: '코드 감사 테스트 보고서',
  severity: KO_SEVERITY,
  comparison: KO_COMPARISON,
  review: KO_REVIEW,
  sections: {
    actions: '조치 목록 · 파일별',
    details: '문제 상세',
    method: '방법 및 근거',
    rulesAppendix: '부록 · 규칙 설명',
  },
  meta: {
    engine: '스캔 엔진',
    sourceHash: '소스 코드 해시',
    commandLine: '엔진 명령줄',
    generatedAt: '보고서 생성 일시',
    finishedAt: '완료 일시',
    rulesLabel: '규칙',
  },
  metrics: { total: '총 위험 수', critical: '심각', high: '높음', files: '관련 파일' },
  distTitle: '위험 분포',
  top5Title: '문제가 가장 많은 상위 5개 파일',
  top5Hint: '건수 기준으로 정렬되며, 위험 우선순위를 나타내는 것은 아닙니다. 위험 우선순위는 "조치 목록"을 참고하세요.',
  thFile: '파일',
  thCount: '합계',
  thMaxSeverity: '최고 심각도',
  scopeLabel: '검사 범위',
  baselineLabel: '베이스라인 비교',
  distLabel: '문제 분포',
  distSentence: (total: number, files: number, rules: number) =>
    `${total}개의 문제가 ${files}개 파일, ${rules}개 규칙에 걸쳐 있습니다`,
  firstScanNoBaseline: '첫 스캔이므로 비교할 베이스라인이 없습니다',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `베이스라인 ${id} 대비: 신규 ${added} · 잔존 ${remaining} · 수정 완료 ${fixed}`,
  actionsHint: (files: number) =>
    `총 ${files}개 파일이며, "최고 심각도 우선, 같은 등급은 문제 수 내림차순"으로 정렬되어 있습니다. 위에서부터 차례로 수정을 진행하는 것을 권장합니다.`,
  thFileMainIssue: '파일 / 주요 문제',
  groupCount: (count: number, files: number) => `${count}건 · ${files}개 파일`,
  groupHint: {
    critical: '원격 코드 실행이나 인증 정보 유출로 직결될 수 있습니다. 즉시 수정하고 별도의 설명을 작성하는 것을 권장합니다.',
    high: '일반적인 공격 경로에 위치합니다. 이번 이터레이션 안에서 수정하는 것을 권장합니다.',
    medium: '특정 전제 조건이 필요하거나 영향이 제한적입니다. 다음 이터레이션의 기술 부채 목록에 포함하는 것을 권장합니다.',
    low: '코딩 규약과 유지보수성에 관한 문제입니다. 일상적인 변경 시 함께 수정해 나가면 충분합니다.',
  },
  fixedHeading: (count: number) => `수정 완료(베이스라인 대비, ${count}건)`,
  appendixHint: (rules: number) =>
    `${rules}개 규칙을 최고 심각도 순으로 정렬했습니다(같은 심각도 내에서는 탐지 횟수 순). 같은 규칙의 전체 설명(수정 제안 포함)은 여기에 한 번만 표시됩니다.`,
  ruleStat: (count: number, files: number) => `탐지 ${count}회 · ${files}개 파일`,
  noMessage: '(설명 없음)',
  noDescription: '(결과에 설명이 제공되지 않았습니다)',
  unknownPath: '(알 수 없는 경로)',
  methodSub: { packs: '규칙 세트', repro: '엔진과 재현성', review: '검토 및 커버리지', exclusions: '제외 항목', boundaries: '커버리지 경계' },
  packThName: '규칙 팩',
  packThId: 'ID',
  noPacks: '기록된 규칙 팩이 없습니다',
  sarifImport: (tool?: string) => (tool ? `SARIF 가져오기(${tool})` : 'SARIF 가져오기'),
  filesChecked: '스캔한 파일',
  filesUnit: (n: number) => `${n}개`,
  issuesUnit: (n: number) => `${n}건`,
  durationSeconds: (s: number) => `${s}초`,
  durationMinutes: (m: number, s: number) => `${m}분 ${s}초`,
  exclusions: '프로젝트의 .gitignore를 따르며, node_modules와 .git은 건너뜁니다',
  notCovered: '이 보고서는 로드된 규칙의 탐지 결과만을 반영한 것으로, 다른 결함이 존재하지 않음을 보장하지 않습니다',
  reviewLabel: '수동 검토',
  reviewLine: (s: ReportReviewSummary) =>
    `${s.reviewed}건 검토 완료: 확인됨 ${s.confirmed} · 오탐 ${s.falsePositives} · 수용됨 ${s.accepted}.`,
  reviewNone: '이번 스캔에서는 수동 검토가 이루어지지 않았으며, 모든 문제는 엔진의 원래 판정 결과입니다.',
  noIssues: '이번 스캔에서는 위험 문제가 발견되지 않았습니다.',
  snippetOverflow: (limit: number) =>
    `코드 조각이 상한을 초과하여 앞의 ${limit}건만 표시합니다. 나머지는 스캔 결과 페이지에서 확인해 주세요.`,
  footer: (time: string) =>
    `이 보고서는 Opengrep Studio 코드 감사 워크벤치에서 자동 생성되었습니다 · 생성 일시 ${time} · 규칙 탐지 결과와 심각도는 opengrep 엔진이 산출합니다. 비즈니스 맥락을 고려해 수동 검토를 진행해 주세요.`,
  listSeparator: ', ',
  sentenceSeparator: ' ',
  severityPhrase: (label: string, count: number) => `${label} ${count}건`,
  conclusionNoIssues: (files: string) =>
    `이번 스캔에서 총 ${files}개의 소스 파일을 검사했지만, 활성화된 규칙에는 하나도 적중하지 않았고 위험 문제는 발견되지 않았습니다.`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `이번 스캔에서 총 ${files}개의 소스 파일을 검사하고 위험 문제 ${total}건을 발견했습니다(${sevText}).`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `베이스라인 스캔 ${baseline} 대비 신규 ${added}건, 잔존 ${remaining}건, 수정 완료 ${fixed}건입니다.`,
  urgentHint: (urgent: number) =>
    `심각·높음 문제(총 ${urgent}건)를 우선적으로 수정하고, 수정 후에는 재스캔으로 회귀 여부를 확인하세요.`,
  nonUrgentHint: () =>
    '현재 심각/높음 문제가 없으므로, 비즈니스 우선순위에 따라 중간·낮음 문제의 수정을 진행하세요.',
  summaryReview: (s: ReportReviewSummary) =>
    ` 수동 검토 ${s.reviewed}건 완료(확인됨 ${s.confirmed}, 오탐 ${s.falsePositives}, 조건부 수용 ${s.accepted}).`,
};

const RU_SEVERITY: Record<Severity, string> = {
  critical: 'Критический',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
};
const RU_COMPARISON: Record<ComparisonStatus, string> = {
  new: 'Новая',
  fixed: 'Исправлена',
  remaining: 'Осталась',
};
const RU_REVIEW: Record<ReviewStatus, string> = {
  pending: 'Ожидает проверки',
  confirmed: 'Подтверждена',
  false_positive: 'Ложное срабатывание',
  accepted: 'Принята',
};

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function ruSourceFiles(files: string): string {
  const n = Number(files);
  return Number.isInteger(n) && n > 0
    ? `${files} ${ruPlural(n, 'исходный файл', 'исходных файла', 'исходных файлов')}`
    : `${files} исходных файлов`;
}

const REPORT_TEXT_RU: typeof REPORT_TEXT_ZH = {
  htmlLang: 'ru',
  brand: 'Opengrep Studio · Среда аудита кода',
  docTitle: 'Отчёт о тестовом аудите кода',
  severity: RU_SEVERITY,
  comparison: RU_COMPARISON,
  review: RU_REVIEW,
  sections: {
    actions: 'Список действий · по файлам',
    details: 'Детали проблем',
    method: 'Методика и доказательства',
    rulesAppendix: 'Приложение · Описания правил',
  },
  meta: {
    engine: 'Движок сканирования',
    sourceHash: 'Хеш исходного кода',
    commandLine: 'Командная строка движка',
    generatedAt: 'Время формирования отчёта',
    finishedAt: 'Время завершения',
    rulesLabel: 'Правила',
  },
  metrics: { total: 'Всего рисков', critical: 'Критический', high: 'Высокий', files: 'Затронутые файлы' },
  distTitle: 'Распределение рисков',
  top5Title: '5 файлов с наибольшим числом проблем',
  top5Hint: 'Сортировка выполнена по количеству и не отражает приоритетность рисков; приоритетные риски см. в разделе «Список действий».',
  thFile: 'Файл',
  thCount: 'Всего',
  thMaxSeverity: 'Максимальная критичность',
  scopeLabel: 'Область проверки',
  baselineLabel: 'Базовое сравнение',
  distLabel: 'Распределение проблем',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} ${ruPlural(total, 'проблема', 'проблемы', 'проблем')} в ${files} ${ruPlural(files, 'файле', 'файлах', 'файлах')} и ${rules} ${ruPlural(rules, 'правиле', 'правилах', 'правилах')}`,
  firstScanNoBaseline: 'Первое сканирование — базовый скан для сравнения отсутствует',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `С базовым сканом ${id}: новых ${added} · оставшихся ${remaining} · исправленных ${fixed}`,
  actionsHint: (files: number) =>
    `Всего ${files} ${ruPlural(files, 'файл', 'файла', 'файлов')}; порядок сортировки: «сначала максимальная критичность, при равном уровне — по убыванию числа проблем». Рекомендуется планировать исправления сверху вниз.`,
  thFileMainIssue: 'Файл / основная проблема',
  groupCount: (count: number, files: number) =>
    `${count} ${ruPlural(count, 'проблема', 'проблемы', 'проблем')} · ${files} ${ruPlural(files, 'файл', 'файла', 'файлов')}`,
  groupHint: {
    critical: 'Может непосредственно привести к удалённому выполнению кода или утечке учётных данных; рекомендуется исправить немедленно и подготовить отдельное пояснение.',
    high: 'Расположена на типовых путях атаки; рекомендуется исправить в текущей итерации.',
    medium: 'Требует определённых предусловий или имеет ограниченное воздействие; рекомендуется внести в список технического долга следующей итерации.',
    low: 'Вопросы соблюдения стандартов кодирования и сопровождаемости; можно исправлять попутно с повседневными изменениями.',
  },
  fixedHeading: (count: number) => `Исправлено (сравнение с базовым сканом, ${count})`,
  appendixHint: (rules: number) =>
    `Отсортировано ${rules} ${ruPlural(rules, 'правило', 'правила', 'правил')} по наивысшей критичности (внутри уровня — по числу срабатываний); полное описание правила (включая рекомендации по исправлению) приводится здесь лишь один раз.`,
  ruleStat: (count: number, files: number) =>
    `${count} ${ruPlural(count, 'срабатывание', 'срабатывания', 'срабатываний')} · ${files} ${ruPlural(files, 'файл', 'файла', 'файлов')}`,
  noMessage: '(примечание пока отсутствует)',
  noDescription: '(описание не предоставлено)',
  unknownPath: '(неизвестный путь)',
  methodSub: { packs: 'Наборы правил', repro: 'Движок и воспроизводимость', review: 'Проверка и покрытие', exclusions: 'Исключения', boundaries: 'Границы покрытия' },
  packThName: 'Пакет правил',
  packThId: 'Идентификатор',
  noPacks: 'Записи о пакетах правил отсутствуют',
  sarifImport: (tool?: string) => (tool ? `Импорт SARIF (${tool})` : 'Импорт SARIF'),
  filesChecked: 'Просканированные файлы',
  filesUnit: (n: number) => `${n} ${ruPlural(n, 'файл', 'файла', 'файлов')}`,
  issuesUnit: (n: number) => `${n} ${ruPlural(n, 'проблема', 'проблемы', 'проблем')}`,
  durationSeconds: (s: number) => `${s} сек.`,
  durationMinutes: (m: number, s: number) => `${m} мин ${s} сек`,
  exclusions: 'Соблюдается .gitignore проекта; каталоги node_modules и .git пропускаются',
  notCovered: 'Этот отчёт отражает только срабатывания загруженных правил и не означает отсутствия иных дефектов',
  reviewLabel: 'Ручная проверка',
  reviewLine: (s: ReportReviewSummary) =>
    `Проверено ${s.reviewed} ${ruPlural(s.reviewed, 'проблема', 'проблемы', 'проблем')}: подтверждено ${s.confirmed} · ложных срабатываний ${s.falsePositives} · принято ${s.accepted}.`,
  reviewNone: 'Ручная проверка для этого сканирования не проводилась; все проблемы — исходные вердикты движка.',
  noIssues: 'В этом сканировании проблем, представляющих риск, не обнаружено.',
  snippetOverflow: (limit: number) =>
    `Превышен лимит фрагментов кода — показаны первые ${limit}; остальное смотрите на странице результатов сканирования.`,
  footer: (time: string) =>
    `Отчёт автоматически сформирован Opengrep Studio · время формирования ${time} · срабатывания правил и критичность получены от движка opengrep; проверьте результаты вручную с учётом бизнес-контекста.`,
  listSeparator: ', ',
  sentenceSeparator: ' ',
  severityPhrase: (label: string, count: number) => `${label}: ${count}`,
  conclusionNoIssues: (files: string) =>
    `В этом сканировании проверено ${ruSourceFiles(files)}; ни одно из включённых правил не сработало, проблем не обнаружено.`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `В этом сканировании проверено ${ruSourceFiles(files)}; обнаружено ${total} ${ruPlural(total, 'проблема', 'проблемы', 'проблем')} (${sevText}).`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `По сравнению с базовым сканом ${baseline}: новых ${added}, оставшихся ${remaining}, исправленных ${fixed}.`,
  urgentHint: (urgent: number) =>
    `Рекомендуется в первую очередь устранить проблемы критического и высокого уровня (всего ${urgent}); после исправления выполните повторное сканирование для проверки.`,
  nonUrgentHint: () =>
    'Сейчас проблем критического и высокого уровня нет; устранение проблем среднего и низкого уровня стоит планировать по бизнес-приоритетам.',
  summaryReview: (s: ReportReviewSummary) =>
    ` Ручная проверка завершена: ${s.reviewed} ${ruPlural(s.reviewed, 'проблема', 'проблемы', 'проблем')} (подтверждено ${s.confirmed}, ложных срабатываний ${s.falsePositives}, принято с оговорками ${s.accepted}).`,
};

const FR_SEVERITY: Record<Severity, string> = {
  critical: 'Critique',
  high: 'Élevé',
  medium: 'Moyen',
  low: 'Faible',
};
const FR_COMPARISON: Record<ComparisonStatus, string> = {
  new: 'Nouveau',
  fixed: 'Corrigé',
  remaining: 'Persistant',
};
const FR_REVIEW: Record<ReviewStatus, string> = {
  pending: 'En attente de revue',
  confirmed: 'Confirmé',
  false_positive: 'Faux positif',
  accepted: 'Accepté',
};

function frPlural(n: number, one: string, many: string): string {
  return n > 1 ? many : one;
}

function frSourceFiles(files: string): string {
  const n = Number(files);
  return Number.isInteger(n) && n > 0
    ? `${files} ${frPlural(n, 'fichier source', 'fichiers sources')}`
    : `${files} fichiers sources`;
}

const REPORT_TEXT_FR: typeof REPORT_TEXT_ZH = {
  htmlLang: 'fr',
  brand: 'Opengrep Studio · Atelier d’audit de code',
  docTitle: 'Rapport de test d’audit de code',
  severity: FR_SEVERITY,
  comparison: FR_COMPARISON,
  review: FR_REVIEW,
  sections: {
    actions: 'Liste d’actions · par fichier',
    details: 'Détail des problèmes',
    method: 'Méthode et preuves',
    rulesAppendix: 'Annexe · Descriptions des règles',
  },
  meta: {
    engine: 'Moteur d’analyse',
    sourceHash: 'Hachage du code source',
    commandLine: 'Ligne de commande du moteur',
    generatedAt: 'Rapport généré le',
    finishedAt: 'Terminé le',
    rulesLabel: 'Règles',
  },
  metrics: { total: 'Total des risques', critical: 'Critique', high: 'Élevé', files: 'Fichiers concernés' },
  distTitle: 'Répartition des risques',
  top5Title: '5 fichiers comptant le plus de problèmes',
  top5Hint: 'Le tri est effectué par nombre de problèmes et ne reflète pas la priorité des risques ; les priorités figurent dans la « Liste d’actions ».',
  thFile: 'Fichier',
  thCount: 'Total',
  thMaxSeverity: 'Sévérité maximale',
  scopeLabel: 'Périmètre de vérification',
  baselineLabel: 'Comparaison à la référence',
  distLabel: 'Répartition des problèmes',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} ${frPlural(total, 'problème', 'problèmes')} touchant ${files} ${frPlural(files, 'fichier', 'fichiers')} et ${rules} ${frPlural(rules, 'règle', 'règles')}`,
  firstScanNoBaseline: 'Première analyse, aucune référence à comparer',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `Référence ${id} : ${added} ${frPlural(added, 'nouveau', 'nouveaux')} · ${remaining} ${frPlural(remaining, 'conservé', 'conservés')} · ${fixed} ${frPlural(fixed, 'corrigé', 'corrigés')}`,
  actionsHint: (files: number) =>
    `Au total, ${files} ${frPlural(files, 'fichier', 'fichiers')} ; tri : « sévérité maximale d’abord, puis nombre de problèmes décroissant à sévérité égale ». Il est recommandé de traiter de haut en bas.`,
  thFileMainIssue: 'Fichier / problème principal',
  groupCount: (count: number, files: number) =>
    `${count} ${frPlural(count, 'problème', 'problèmes')} · ${files} ${frPlural(files, 'fichier', 'fichiers')}`,
  groupHint: {
    critical: 'Peut directement mener à l’exécution de code à distance ou à la fuite d’identifiants ; à corriger immédiatement, avec une note explicative distincte.',
    high: 'Se situe sur des voies d’attaque courantes ; à corriger au cours de l’itération en cours.',
    medium: 'Nécessite des conditions préalables ou a un impact limité ; à inscrire à la liste de dette technique de la prochaine itération.',
    low: 'Concerne les conventions de codage et la maintenabilité ; à corriger au fil des modifications courantes.',
  },
  fixedHeading: (count: number) => `Corrigés (par rapport à la référence, ${count})`,
  appendixHint: (rules: number) =>
    `${rules} ${frPlural(rules, 'règle triée', 'règles triées')} par sévérité maximale puis par nombre d’occurrences ; la description complète d’une règle (avec les pistes de correction) n’apparaît ici qu’une seule fois.`,
  ruleStat: (count: number, files: number) =>
    `${count} ${frPlural(count, 'occurrence', 'occurrences')} · ${files} ${frPlural(files, 'fichier', 'fichiers')}`,
  noMessage: '(description momentanément indisponible)',
  noDescription: '(aucune description fournie)',
  unknownPath: '(chemin inconnu)',
  methodSub: { packs: 'Ensembles de règles', repro: 'Moteur et reproductibilité', review: 'Revue et couverture', exclusions: 'Exclusions', boundaries: 'Limites de la couverture' },
  packThName: 'Paquet de règles',
  packThId: 'Identifiant',
  noPacks: 'Aucun paquet de règles enregistré',
  sarifImport: (tool?: string) => (tool ? `Import SARIF (${tool})` : 'Import SARIF'),
  filesChecked: 'Fichiers analysés',
  filesUnit: (n: number) => `${n} ${frPlural(n, 'fichier', 'fichiers')}`,
  issuesUnit: (n: number) => `${n} ${frPlural(n, 'problème', 'problèmes')}`,
  durationSeconds: (s: number) => `${s} s`,
  durationMinutes: (m: number, s: number) => `${m} min ${s} s`,
  exclusions: 'Respecte le fichier .gitignore du projet ; les dossiers node_modules et .git sont ignorés',
  notCovered: 'Ce rapport ne reflète que les correspondances des règles chargées et ne garantit pas l’absence d’autres défauts',
  reviewLabel: 'Revue manuelle',
  reviewLine: (s: ReportReviewSummary) =>
    `${s.reviewed} ${frPlural(s.reviewed, 'problème examiné', 'problèmes examinés')} : ${s.confirmed} ${frPlural(s.confirmed, 'confirmé', 'confirmés')} · ${s.falsePositives} ${frPlural(s.falsePositives, 'faux positif', 'faux positifs')} · ${s.accepted} ${frPlural(s.accepted, 'accepté', 'acceptés')}.`,
  reviewNone: 'Aucune revue manuelle n’a été effectuée lors de cette analyse ; tous les problèmes reflètent le verdict brut du moteur.',
  noIssues: 'Aucun problème à risque n’a été détecté lors de cette analyse.',
  snippetOverflow: (limit: number) =>
    `Limite d’extraits de code atteinte — seuls les ${limit} premiers sont affichés ; consultez la page de résultats de l’analyse pour les autres.`,
  footer: (time: string) =>
    `Rapport généré automatiquement par Opengrep Studio · généré le ${time} · les correspondances de règles et les sévérités sont produites par le moteur opengrep ; à réviser manuellement selon le contexte métier.`,
  listSeparator: ', ',
  sentenceSeparator: ' ',
  severityPhrase: (label: string, count: number) => `${label} : ${count}`,
  conclusionNoIssues: (files: string) =>
    `Cette analyse a vérifié ${frSourceFiles(files)}, sans qu’aucune règle activée ne soit déclenchée ; aucun problème à risque n’a été détecté.`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `Cette analyse a vérifié ${frSourceFiles(files)} et détecté ${total} ${frPlural(total, 'problème à risque', 'problèmes à risque')} (${sevText}).`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `Par rapport à l’analyse de référence ${baseline} : ${added} ${frPlural(added, 'nouveau', 'nouveaux')}, ${remaining} ${frPlural(remaining, 'conservé', 'conservés')}, ${fixed} ${frPlural(fixed, 'corrigé', 'corrigés')}.`,
  urgentHint: (urgent: number) =>
    `Il est recommandé de traiter en priorité les problèmes critiques et de sévérité élevée (${urgent} au total), puis de relancer une analyse pour vérifier les corrections.`,
  nonUrgentHint: () =>
    'Aucun problème critique ou de sévérité élevée à ce stade ; planifiez la correction des problèmes moyens et faibles selon les priorités métier.',
  summaryReview: (s: ReportReviewSummary) =>
    ` Revue manuelle effectuée sur ${s.reviewed} ${frPlural(s.reviewed, 'problème', 'problèmes')} (${s.confirmed} ${frPlural(s.confirmed, 'confirmé', 'confirmés')}, ${s.falsePositives} ${frPlural(s.falsePositives, 'faux positif', 'faux positifs')}, ${s.accepted} ${frPlural(s.accepted, 'accepté sous conditions', 'acceptés sous conditions')}).`,
};

const DE_SEVERITY: Record<Severity, string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};
const DE_COMPARISON: Record<ComparisonStatus, string> = {
  new: 'Neu',
  fixed: 'Behoben',
  remaining: 'Bestehend',
};
const DE_REVIEW: Record<ReviewStatus, string> = {
  pending: 'Prüfung ausstehend',
  confirmed: 'Bestätigt',
  false_positive: 'Falsch positiv',
  accepted: 'Akzeptiert',
};

function dePlural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function deSourceFiles(files: string): string {
  const n = Number(files);
  return Number.isInteger(n) && n > 0
    ? `${files} ${dePlural(n, 'Quellcodedatei', 'Quellcodedateien')}`
    : `${files} Quellcodedateien`;
}

const REPORT_TEXT_DE: typeof REPORT_TEXT_ZH = {
  htmlLang: 'de',
  brand: 'Opengrep Studio · Arbeitsbereich für Code-Audit',
  docTitle: 'Code-Audit-Testbericht',
  severity: DE_SEVERITY,
  comparison: DE_COMPARISON,
  review: DE_REVIEW,
  sections: {
    actions: 'Maßnahmenliste · nach Datei',
    details: 'Problemdetails',
    method: 'Methodik und Nachweise',
    rulesAppendix: 'Anhang · Regelbeschreibungen',
  },
  meta: {
    engine: 'Scan-Engine',
    sourceHash: 'Hash des Quellcodes',
    commandLine: 'Engine-Kommandozeile',
    generatedAt: 'Bericht erstellt am',
    finishedAt: 'Abgeschlossen am',
    rulesLabel: 'Regeln',
  },
  metrics: { total: 'Gesamtzahl der Risiken', critical: 'Kritisch', high: 'Hoch', files: 'Betroffene Dateien' },
  distTitle: 'Risikoverteilung',
  top5Title: 'Die 5 Dateien mit den meisten Problemen',
  top5Hint: 'Sortiert nach Anzahl – entspricht nicht der Risikopriorität; die Prioritäten finden Sie in der „Maßnahmenliste“.',
  thFile: 'Datei',
  thCount: 'Gesamt',
  thMaxSeverity: 'Maximaler Schweregrad',
  scopeLabel: 'Prüfumfang',
  baselineLabel: 'Baseline-Vergleich',
  distLabel: 'Problemverteilung',
  distSentence: (total: number, files: number, rules: number) =>
    `${total} ${dePlural(total, 'Problem', 'Probleme')} in ${files} ${dePlural(files, 'Datei', 'Dateien')} und ${rules} ${dePlural(rules, 'Regel', 'Regeln')}`,
  firstScanNoBaseline: 'Erster Scan – keine Baseline zum Vergleich',
  baselineSentence: (id: string, added: number, remaining: number, fixed: number) =>
    `Gegenüber der Baseline ${id}: ${added} ${dePlural(added, 'neues', 'neue')} · ${remaining} ${dePlural(remaining, 'bestehendes', 'bestehende')} · ${fixed} ${dePlural(fixed, 'behobenes', 'behobene')}`,
  actionsHint: (files: number) =>
    `Insgesamt ${files} ${dePlural(files, 'Datei', 'Dateien')}; Sortierung: „maximaler Schweregrad zuerst, bei gleicher Stufe nach Problemzahl absteigend“. Es wird empfohlen, von oben nach unten zu arbeiten.`,
  thFileMainIssue: 'Datei / Hauptproblem',
  groupCount: (count: number, files: number) =>
    `${count} ${dePlural(count, 'Problem', 'Probleme')} · ${files} ${dePlural(files, 'Datei', 'Dateien')}`,
  groupHint: {
    critical: 'Kann direkt zur Remote-Code-Ausführung oder zur Offenlegung von Zugangsdaten führen; sofort beheben und gesondert dokumentieren.',
    high: 'Liegt auf typischen Angriffspfaden; sollte noch in der aktuellen Iteration behoben werden.',
    medium: 'Erfordert besondere Voraussetzungen oder hat begrenzte Auswirkungen; in die Liste der technischen Schulden der nächsten Iteration aufnehmen.',
    low: 'Betrifft Codekonventionen und Wartbarkeit; kann bei alltäglichen Änderungen nebenbei behoben werden.',
  },
  fixedHeading: (count: number) => `Behoben (gegenüber der Baseline, ${count})`,
  appendixHint: (rules: number) =>
    `${rules} ${dePlural(rules, 'Regel', 'Regeln')}, sortiert nach höchstem Schweregrad, dann nach Trefferzahl; die vollständige Beschreibung einer Regel (inkl. Lösungshinweisen) erscheint hier nur einmal.`,
  ruleStat: (count: number, files: number) =>
    `${count} ${dePlural(count, 'Treffer', 'Treffer')} · ${files} ${dePlural(files, 'Datei', 'Dateien')}`,
  noMessage: '(noch keine Beschreibung)',
  noDescription: '(keine Beschreibung angegeben)',
  unknownPath: '(unbekannter Pfad)',
  methodSub: { packs: 'Regelsätze', repro: 'Engine und Reproduzierbarkeit', review: 'Prüfung und Abdeckung', exclusions: 'Ausschlüsse', boundaries: 'Abdeckungsgrenzen' },
  packThName: 'Regelpaket',
  packThId: 'Kennung',
  noPacks: 'Keine Regelpakete erfasst',
  sarifImport: (tool?: string) => (tool ? `SARIF-Import (${tool})` : 'SARIF-Import'),
  filesChecked: 'Gescannte Dateien',
  filesUnit: (n: number) => `${n} ${dePlural(n, 'Datei', 'Dateien')}`,
  issuesUnit: (n: number) => `${n} ${dePlural(n, 'Problem', 'Probleme')}`,
  durationSeconds: (s: number) => `${s} s`,
  durationMinutes: (m: number, s: number) => `${m} min ${s} s`,
  exclusions: 'Beachtet die .gitignore des Projekts; node_modules und .git werden übersprungen',
  notCovered: 'Dieser Bericht spiegelt nur die Treffer der geladenen Regeln wider und belegt nicht das Fehlen weiterer Mängel',
  reviewLabel: 'Manuelle Prüfung',
  reviewLine: (s: ReportReviewSummary) =>
    `${s.reviewed} ${dePlural(s.reviewed, 'Problem geprüft', 'Probleme geprüft')}: ${s.confirmed} bestätigt · ${s.falsePositives} falsch positiv · ${s.accepted} akzeptiert.`,
  reviewNone: 'In diesem Scan fand keine manuelle Prüfung statt; alle Probleme entsprechen den unveränderten Bewertungen der Engine.',
  noIssues: 'In diesem Scan wurden keine Risikoprobleme gefunden.',
  snippetOverflow: (limit: number) =>
    `Limit für Codeausschnitte erreicht – nur die ersten ${limit} werden angezeigt; den Rest finden Sie auf der Scan-Ergebnisseite.`,
  footer: (time: string) =>
    `Dieser Bericht wurde automatisch von Opengrep Studio erstellt · Erstellungszeit: ${time} · Regeltreffer und Schweregrade stammen von der opengrep-Engine; bitte im Geschäftskontext manuell prüfen.`,
  listSeparator: ', ',
  sentenceSeparator: ' ',
  severityPhrase: (label: string, count: number) => `${label}: ${count}`,
  conclusionNoIssues: (files: string) =>
    `In diesem Scan wurden ${deSourceFiles(files)} geprüft; keine der aktivierten Regeln ist angesprungen und es wurden keine Risikoprobleme gefunden.`,
  conclusionSummary: (files: string, total: number, sevText: string) =>
    `In diesem Scan wurden ${deSourceFiles(files)} geprüft und ${total} ${dePlural(total, 'Risikoproblem', 'Risikoprobleme')} gefunden (${sevText}).`,
  comparisonSentence: (baseline: string, added: number, remaining: number, fixed: number) =>
    `Gegenüber dem Baseline-Scan ${baseline}: ${added} ${dePlural(added, 'neues', 'neue')}, ${remaining} ${dePlural(remaining, 'bestehendes', 'bestehende')}, ${fixed} ${dePlural(fixed, 'behobenes', 'behobene')}.`,
  urgentHint: (urgent: number) =>
    `Es wird empfohlen, kritische und hohe Probleme vorrangig zu beheben (insgesamt ${urgent}) und anschließend zur Verifikation erneut zu scannen.`,
  nonUrgentHint: () =>
    'Zurzeit liegen keine kritischen oder hohen Probleme vor; die Behebung der mittleren und niedrigen Probleme sollte nach Geschäftsprioritäten eingeplant werden.',
  summaryReview: (s: ReportReviewSummary) =>
    ` Manuelle Prüfung abgeschlossen für ${s.reviewed} ${dePlural(s.reviewed, 'Problem', 'Probleme')} (${s.confirmed} bestätigt, ${s.falsePositives} falsch positiv, ${s.accepted} unter Vorbehalt akzeptiert).`,
};

type ReportText = typeof REPORT_TEXT_ZH;

const REPORT_TEXT: Record<ReportLang, ReportText> = {
  zh: REPORT_TEXT_ZH,
  'zh-Hant': REPORT_TEXT_HANT,
  en: REPORT_TEXT_EN,
  ja: REPORT_TEXT_JA,
  ko: REPORT_TEXT_KO,
  ru: REPORT_TEXT_RU,
  fr: REPORT_TEXT_FR,
  de: REPORT_TEXT_DE,
};

interface ConclusionInput {
  fileCount?: number | null;
  baselineScanId?: string | null;
  totals: ReportTotals;
  reviewStats?: ReportReviewSummary;
}

function composeConclusion(input: ConclusionInput, text: ReportText): string {
  const { totals } = input;
  const files = input.fileCount ? String(input.fileCount) : '—';
  let base: string;
  if (totals.total === 0) {
    base = text.conclusionNoIssues(files);
  } else {
    const sevText = SEVERITY_ORDER.filter((sev) => totals.bySeverity[sev] > 0)
      .map((sev) => text.severityPhrase(text.severity[sev], totals.bySeverity[sev]))
      .join(text.listSeparator);
    const parts = [text.conclusionSummary(files, totals.total, sevText)];
    if (input.baselineScanId) {
      parts.push(
        text.comparisonSentence(
          input.baselineScanId,
          totals.byComparison.new,
          totals.byComparison.remaining,
          totals.byComparison.fixed,
        ),
      );
    }
    const urgent = totals.bySeverity.critical + totals.bySeverity.high;
    parts.push(urgent > 0 ? text.urgentHint(urgent) : text.nonUrgentHint());
    base = parts.join(text.sentenceSeparator);
  }
  const review = input.reviewStats;
  return review && review.reviewed > 0 ? `${base}${text.summaryReview(review)}` : base;
}

const TOP_FILES_LIMIT = 10;
const SNIPPET_LIMIT = 100;

export function buildReportData(
  scan: ScanRecord,
  project: Project,
  issues: IssueRow[],
  engineVersion?: string,
  reviews: Review[] = [],
): ReportData {
  const current = issues.filter(isActiveIssue);
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of current) bySeverity[issue.severity] += 1;
  const byComparison: Record<ComparisonStatus, number> = { new: 0, fixed: 0, remaining: 0 };
  for (const issue of issues) byComparison[issue.comparisonStatus] += 1;

  const reviewMap = new Map(reviews.map((review) => [review.fingerprint, review]));
  const reviewStats: ReportReviewSummary = { reviewed: 0, confirmed: 0, falsePositives: 0, accepted: 0 };
  const attachReview = (issue: IssueRow): Issue & { review?: ReportIssueReview } => {
    const review = reviewMap.get(issue.fingerprint);
    const { fingerprint: _fp, matchedLines: _ml, ...rest } = issue;
    if (!review || review.status === 'pending') return rest;
    reviewStats.reviewed += 1;
    if (review.status === 'confirmed') reviewStats.confirmed += 1;
    else if (review.status === 'false_positive') reviewStats.falsePositives += 1;
    else if (review.status === 'accepted') reviewStats.accepted += 1;
    return {
      ...rest,
      review: {
        status: review.status,
        ...(review.reason ? { reason: review.reason } : {}),
        ...(review.reviewer ? { reviewer: review.reviewer } : {}),
        ...(review.updatedAt ? { updatedAt: review.updatedAt } : {}),
      },
    };
  };

  const topFiles = aggregateFileIssues(current)
    .map(({ bySev, ruleCounts, ...rest }) => {
      const topRule = topRuleOf(ruleCounts);
      return topRule ? { ...rest, topRule } : rest;
    })
    .sort((a, b) => b.count - a.count || SEVERITY_RANK[a.maxSeverity] - SEVERITY_RANK[b.maxSeverity])
    .slice(0, TOP_FILES_LIMIT);

  const durationStart = scan.startedAt ?? scan.scannedAt;
  const durationSeconds =
    scan.finishedAt && durationStart
      ? Math.max(
          0,
          Math.round(
            (new Date(scan.finishedAt).getTime() - new Date(durationStart).getTime()) / 1000,
          ),
        )
      : undefined;

  const meta: ReportMeta = {
    projectId: project.id,
    projectName: project.name,
    projectDescription: project.description,
    language: project.language,
    scanId: scan.id,
    scannedAt: scan.scannedAt,
    finishedAt: scan.finishedAt,
    durationSeconds,
    fileCount: scan.fileCount,
    baselineScanId: scan.baselineScanId,
    rulepacks: scan.rulepacks,
    rules: scan.rules?.startsWith('cfg-') ? undefined : scan.rules,
    ...(scan.importSource ? { importSource: scan.importSource } : {}),
    ...(scan.toolName ? { toolName: scan.toolName } : {}),
    engineVersion,
    sourceHash: scan.srcHash,
    commandLine: scan.commandLine,
    generatedAt: new Date().toISOString(),
  };

  const mappedIssues = issues.map(attachReview);
  const totals: ReportTotals = { total: current.length, bySeverity, byComparison };
  const conclusionInput: ConclusionInput = {
    fileCount: scan.fileCount,
    baselineScanId: scan.baselineScanId,
    totals,
    ...(reviewStats.reviewed > 0 ? { reviewStats } : {}),
  };
  return {
    meta,
    totals,
    conclusion: composeConclusion(conclusionInput, REPORT_TEXT_ZH),
    conclusionCode: buildConclusionPayload(scan, totals),
    topFiles,
    issues: mappedIssues,
    ...(reviewStats.reviewed > 0 ? { reviewStats } : {}),
  };
}

function buildConclusionPayload(scan: ScanRecord, totals: ReportTotals): ConclusionPayload | null {
  const { bySeverity, byComparison } = totals;
  const fileCount = scan.fileCount ?? 0;
  const urgent = bySeverity.critical + bySeverity.high;
  const message = composeConclusion(
    { fileCount: scan.fileCount, baselineScanId: scan.baselineScanId, totals },
    REPORT_TEXT_ZH,
  );
  if (totals.total === 0) {
    return {
      code: 'noIssues',
      params: { files: fileCount, baseline: scan.baselineScanId ?? '' },
      message,
    };
  }
  return {
    code: 'summary',
    params: {
      files: fileCount,
      total: totals.total,
      critical: bySeverity.critical,
      high: bySeverity.high,
      medium: bySeverity.medium,
      low: bySeverity.low,
      baseline: scan.baselineScanId ?? '',
      baselineNew: byComparison.new,
      baselineRemaining: byComparison.remaining,
      baselineFixed: byComparison.fixed,
      urgent,
    },
    message,
  };
}


function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(seconds: number, text: ReportText): string {
  if (seconds < 60) return text.durationSeconds(seconds);
  return text.durationMinutes(Math.floor(seconds / 60), seconds % 60);
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#d92b2b',
  high: '#e8930c',
  medium: '#1f7fe0',
  low: '#8a94a6',
};


function firstSentence(value: string): string {
  const text = String(value ?? '').trim();
  const cut = text.split(/(?<=[。！？])/)[0] || text;
  return cut.length > 64 ? `${cut.slice(0, 64)}…` : cut;
}

function isAbsolutePathToken(token: string): boolean {
  return token.startsWith('/') || token.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(token);
}

export function sanitizeCommand(cmd: string): string {
  return cmd.replace(/"([^"]*)"|(\S+)/g, (match: string, quoted?: string, bare?: string) => {
    const token = quoted ?? bare ?? '';
    if (!isAbsolutePathToken(token)) return match;
    const base = token
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop();
    const masked = base ? `<repo>/${base}` : '<repo>';
    return quoted !== undefined ? `"${masked}"` : masked;
  });
}

function pathHtml(p: string, unknownLabel: string): string {
  const s = String(p ?? '');
  if (!s) return `<span class="fname">${escapeHtml(unknownLabel)}</span>`;
  const cut = s.lastIndexOf('/') + 1;
  return `<span class="dir">${escapeHtml(s.slice(0, cut))}</span><span class="fname">${escapeHtml(s.slice(cut))}</span>`;
}

function buildMessageLookup(messages?: Record<string, string>) {
  if (!messages) return (_ruleId: string, fallback: string) => fallback;
  const exact = new Map(Object.entries(messages));
  const bySuffix = new Map<string, string>();
  for (const [key, value] of exact) {
    const idx = key.lastIndexOf('.');
    if (idx >= 0 && !bySuffix.has(key.slice(idx + 1))) bySuffix.set(key.slice(idx + 1), value);
  }
  return (ruleId: string, fallback: string) => exact.get(ruleId) ?? bySuffix.get(ruleId) ?? fallback;
}

type ReportIssue = Issue & { review?: ReportIssueReview };

function issueEntryHtml(
  issue: ReportIssue,
  snippets: Map<string, string>,
  snippetBudget: { left: number },
  text: ReportText,
  lookup: (ruleId: string, fallback: string) => string,
): string {
  const showSnippet =
    snippetBudget.left > 0 &&
    (issue.severity === 'critical' || issue.severity === 'high') &&
    snippets.has(issue.id);
  if (showSnippet) snippetBudget.left -= 1;
  const lineRange =
    issue.endLine && issue.endLine !== issue.startLine
      ? `:${issue.startLine}\u2013${issue.endLine}`
      : `:${issue.startLine}`;
  const tags = [
    issue.comparisonStatus !== 'remaining'
      ? `<span class="tag tag-${issue.comparisonStatus}">${text.comparison[issue.comparisonStatus]}</span>`
      : '',
    issue.review ? `<span class="tag tag-review">${text.review[issue.review.status]}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  return `<div class="entry">
      <div class="entry-head">
        <span class="line">${escapeHtml(lineRange)}</span>
        <span class="rule">${escapeHtml(issue.ruleId)}</span>
      </div>
      <div class="entry-msg">${escapeHtml(lookup(issue.ruleId, firstSentence(issue.message)) || text.noDescription)}</div>
      ${showSnippet ? `<pre class="entry-snippet">${escapeHtml(snippets.get(issue.id) ?? '')}</pre>` : ''}
      ${tags ? `<div class="entry-tags">${tags}</div>` : ''}
    </div>`;
}

function detailGroupHtml(options: {
  heading: string;
  sub: string;
  hint?: string;
  accent: string;
  first: boolean;
  list: ReportIssue[];
  snippets: Map<string, string>;
  snippetBudget: { left: number };
  text: ReportText;
  lookup: (ruleId: string, fallback: string) => string;
}): string {
  const { text, lookup } = options;
  const byFile = new Map<string, ReportIssue[]>();
  for (const issue of options.list) {
    const bucket = byFile.get(issue.filePath);
    if (bucket) bucket.push(issue);
    else byFile.set(issue.filePath, [issue]);
  }
  const blocks = [...byFile.entries()]
    .map(
      ([filePath, list]) => `<div class="file-block">
      <div class="file-head">
        <span class="fpath">${pathHtml(filePath, text.unknownPath)}</span>
        <span class="file-count">${text.issuesUnit(list.length)}</span>
      </div>
      ${list.map((issue) => issueEntryHtml(issue, options.snippets, options.snippetBudget, text, lookup)).join('')}
    </div>`,
    )
    .join('');
  return `<section class="block${options.first ? '' : ' flow'}">
    <h2 class="group" style="border-left-color:${options.accent}">${escapeHtml(options.heading)}<span class="count">${escapeHtml(options.sub)}</span></h2>
    ${options.hint ? `<p class="hint">${escapeHtml(options.hint)}</p>` : ''}
    ${blocks}
  </section>`;
}

export interface HtmlRenderOptions {
  includeSnippets: boolean;
}

const REPORT_CSS = `
  :root{
    --fg:#1a1f29; --fg-2:#3d4657; --muted:#6b7689; --faint:#8a94a6;
    --line:#e3e8f0; --soft:#f5f7fb; --softer:#fafbfd; --brand:#1a4f9c;
    --mono:'JetBrains Mono',Consolas,'Cascadia Code','Courier New',monospace;
  }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: var(--fg); background: #fff;
    font-family: -apple-system, 'BlinkMacSystemFont', 'Helvetica Neue', Tahoma,
      'PingFang SC', 'Microsoft Yahei', 'Hiragino Sans GB', sans-serif;
    font-size: 14px; line-height: 1.55;
  }
  html:lang(zh-Hant) body {
    font-family: -apple-system, 'BlinkMacSystemFont', 'Helvetica Neue', Tahoma,
      'PingFang TC', 'PingFang SC', 'Microsoft JhengHei', 'Microsoft Yahei', 'Hiragino Sans GB', sans-serif;
  }
  html:lang(ja) body {
    font-family: -apple-system, 'BlinkMacSystemFont', 'Helvetica Neue', Tahoma,
      'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Yu Gothic', 'Meiryo', sans-serif;
  }
  html:lang(ko) body {
    font-family: -apple-system, 'BlinkMacSystemFont', 'Helvetica Neue', Tahoma,
      'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif;
  }
  html:lang(ru) body,
  html:lang(fr) body,
  html:lang(de) body {
    font-family: -apple-system, 'BlinkMacSystemFont', 'Helvetica Neue', Tahoma, sans-serif;
  }
  .doc { max-width: 760px; margin: 0 auto; padding: 28px 32px 48px; }
  h1, h2, h3 { margin: 0; font-weight: 600; }
  .mono { font-family: var(--mono); }
  .muted { color: var(--muted); }

  .cover-top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--fg); padding-bottom: 10px; margin-bottom: 16px; }
  .cover-top .proj { font-size: 12.5px; color: var(--muted); }
  h1 { font-size: 28px; letter-spacing: .5px; margin-top: 2px; }
  .doc-meta { font-size: 12px; color: var(--muted); text-align: right; line-height: 1.7; }
  .doc-meta b { color: var(--fg-2); font-weight: 500; }

  .conclusion { background: var(--softer); border-left: 3px solid var(--brand); padding: 12px 14px; margin: 0 0 16px; }
  .conclusion p { margin: 0; }

  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
  .metric { border: 1px solid var(--line); border-radius: 6px; padding: 9px 12px; background: var(--softer); }
  .metric .k { font-size: 12px; color: var(--muted); }
  .metric .v { font-size: 25px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }

  h2.sec { font-size: 17px; padding-bottom: 5px; border-bottom: 1px solid var(--line); margin: 0 0 8px; }
  h3.sub { font-size: 14px; margin: 16px 0 6px; color: var(--fg-2); }

  .bar-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 12.5px; }
  .bar-label { flex: 0 0 84px; color: var(--fg-2); }
  .bar-track { flex: 1; height: 10px; background: var(--soft); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 5px; }
  .bar-value { flex: 0 0 92px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar-value em { font-style: normal; color: var(--faint); font-size: 11px; margin-left: 4px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { border-bottom: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: var(--soft); font-weight: 600; font-size: 12px; color: var(--fg-2); white-space: nowrap; }
  tbody tr:nth-child(even) { background: var(--softer); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.num.strong { font-weight: 600; }
  td.num.crit { color: #d92b2b; }
  td.num.hi { color: var(--high-c, #c76a00); }
  td.num.mid { color: #1f7fe0; }
  td.num.low { color: var(--faint); }
  td.path { overflow-wrap: anywhere; }
  .path .dir { color: var(--muted); word-break: break-all; }
  .path .fname { color: var(--fg-2); white-space: nowrap; }
  .sub-rule { font-family: var(--mono); font-size: 11px; color: var(--faint); margin-top: 1px; }
  .sev-chip { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 3px; white-space: nowrap; }

  .block { break-before: page; page-break-before: always; }
  .block:first-of-type { break-before: auto; page-break-before: auto; }
  .block.flow { break-before: auto; page-break-before: auto; }
  h2.group { font-size: 17px; border-bottom: 1px solid var(--line); border-left: 4px solid var(--line); padding: 0 0 5px 9px; margin: 14px 0 3px; break-after: avoid; page-break-after: avoid; }
  h2.group .count { font-size: 12.5px; color: var(--muted); font-weight: 400; margin-left: 6px; }
  .hint { font-size: 12px; color: var(--muted); margin: 0 0 6px; }

  .file-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 12px 0 3px; padding: 3px 8px; background: var(--soft); border-left: 3px solid var(--brand); border-radius: 0 4px 4px 0; break-after: avoid; page-break-after: avoid; }
  .file-head .fpath { font-size: 12px; font-weight: 600; min-width: 0; }
  .file-head .fname { color: var(--fg); }
  .file-count { font-size: 11px; color: var(--muted); white-space: nowrap; flex: 0 0 auto; }

  .entry { padding: 4px 0; border-bottom: 1px solid var(--line); break-inside: avoid; page-break-inside: avoid; }
  .entry-head { display: flex; align-items: baseline; gap: 10px; }
  .entry .line { font-family: var(--mono); font-size: 11px; color: var(--muted); flex: 0 0 66px; white-space: nowrap; }
  .entry .rule { font-family: var(--mono); font-size: 11px; color: var(--fg-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-msg { font-size: 12.5px; color: var(--fg-2); margin: 1px 0 0 68px; }
  .entry-tags { margin: 3px 0 0 68px; display: flex; gap: 5px; }
  .entry-snippet {
    margin: 4px 0 2px 68px; padding: 8px 10px; background: #0f172a; color: #dce4f2;
    border-radius: 6px; font-family: var(--mono); font-size: 11px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-all;
  }
  .tag { display: inline-block; font-size: 10.5px; padding: 0 6px; border-radius: 3px; line-height: 1.6; white-space: nowrap; }
  .tag-new { background: #fbe9e9; color: #c92a2a; }
  .tag-remaining { background: #fdf1dd; color: #a35a00; }
  .tag-fixed { background: #e2f5ec; color: #1e7d55; }
  .tag-review { background: var(--soft); color: var(--muted); }

  .rule-card { padding: 7px 0; border-bottom: 1px solid var(--line); break-inside: avoid; page-break-inside: avoid; }
  .rule-head { display: flex; align-items: baseline; gap: 8px; }
  .rule-idx { font-size: 11px; color: var(--faint); flex: 0 0 18px; }
  .rule-name { font-family: var(--mono); font-size: 12px; color: var(--fg-2); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .rule-stat { font-size: 11px; color: var(--muted); margin-left: auto; white-space: nowrap; }
  .rule-text { margin: 2px 0 0 26px; font-size: 12px; color: var(--fg-2); line-height: 1.5; }

  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; font-size: 12.5px; margin: 0 0 12px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; word-break: break-all; }
  pre.cmd { background: var(--softer); border: 1px solid var(--line); border-radius: 5px; padding: 8px 10px; font-family: var(--mono); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; margin: 0 0 10px; }

  .foot { margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 11px; color: var(--faint); display: flex; justify-content: space-between; gap: 12px; }

  @media print {
    body { background: #fff; }
    .doc { max-width: none; padding: 0; }
    @page { size: A4; margin: 14mm 12mm; }
    thead { display: table-header-group; }
    tr, .metric, .bar-row, .conclusion, .rule-card { break-inside: avoid; page-break-inside: avoid; }
    h2.sec, h2.group, h3.sub, .file-head { break-after: avoid; page-break-after: avoid; }
  }
`;

interface FileIssueAgg {
  filePath: string;
  count: number;
  bySev: Record<Severity, number>;
  maxSeverity: Severity;
  ruleCounts: Map<string, number>;
}

function topRuleOf(ruleCounts: Map<string, number>): string {
  const [topRule] = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]);
  return topRule?.[0] ?? '';
}

function aggregateFileIssues(
  issues: ReadonlyArray<Pick<IssueRow, 'filePath' | 'severity' | 'ruleId'>>,
): FileIssueAgg[] {
  const fileMap = new Map<string, FileIssueAgg>();
  for (const issue of issues) {
    let file = fileMap.get(issue.filePath);
    if (!file) {
      file = {
        filePath: issue.filePath,
        count: 0,
        bySev: { critical: 0, high: 0, medium: 0, low: 0 },
        maxSeverity: issue.severity,
        ruleCounts: new Map(),
      };
      fileMap.set(issue.filePath, file);
    }
    file.count += 1;
    file.bySev[issue.severity] += 1;
    file.ruleCounts.set(issue.ruleId, (file.ruleCounts.get(issue.ruleId) ?? 0) + 1);
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[file.maxSeverity]) {
      file.maxSeverity = issue.severity;
    }
  }
  return [...fileMap.values()];
}

interface RuleStat {
  id: string;
  count: number;
  files: Set<string>;
  maxSev: Severity;
}

function aggregateRuleStats(issues: ReportIssue[]): RuleStat[] {
  const ruleMap = new Map<string, RuleStat>();
  for (const issue of issues) {
    let rule = ruleMap.get(issue.ruleId);
    if (!rule) {
      rule = { id: issue.ruleId, count: 0, files: new Set(), maxSev: issue.severity };
      ruleMap.set(issue.ruleId, rule);
    }
    rule.count += 1;
    rule.files.add(issue.filePath);
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[rule.maxSev]) rule.maxSev = issue.severity;
  }
  return [...ruleMap.values()].sort(
    (a, b) => SEVERITY_RANK[a.maxSev] - SEVERITY_RANK[b.maxSev] || b.count - a.count,
  );
}

export function renderReportHtml(
  data: ReportData,
  issues: IssueRow[],
  options: HtmlRenderOptions,
  lang: ReportLang = 'zh',
  messages?: Record<string, string>,
): string {
  const { meta, totals, reviewStats } = data;
  const text = REPORT_TEXT[lang];
  const reviewById = new Map(
    data.issues.filter((issue) => issue.review).map((issue) => [issue.id, issue.review!]),
  );
  const withReview = (rows: IssueRow[]): ReportIssue[] =>
    rows.map((issue) => ({ ...issue, review: reviewById.get(issue.id) }));
  const current = withReview(issues.filter(isActiveIssue));
  const fixed = withReview(issues.filter((issue) => issue.comparisonStatus === 'fixed'));
  const lookup = buildMessageLookup(messages);

  const snippets = new Map<string, string>();
  if (options.includeSnippets) {
    for (const issue of issues) {
      if (issue.matchedLines) snippets.set(issue.id, issue.matchedLines);
    }
  }
  const snippetBudget = { left: SNIPPET_LIMIT };

  const fileList = aggregateFileIssues(current)
    .map(({ ruleCounts, filePath, ...rest }) => ({
      path: filePath,
      ...rest,
      topRule: topRuleOf(ruleCounts),
    }))
    .sort((a, b) => SEVERITY_RANK[a.maxSeverity] - SEVERITY_RANK[b.maxSeverity] || b.count - a.count);
  const ruleList = aggregateRuleStats(current);

  const conclusionText = escapeHtml(
    composeConclusion(
      {
        fileCount: data.meta.fileCount,
        baselineScanId: data.meta.baselineScanId,
        totals: data.totals,
        ...(data.reviewStats ? { reviewStats: data.reviewStats } : {}),
      },
      text,
    ),
  );
  const metricsHtml = `
    <div class="metrics">
      <div class="metric"><div class="k">${text.metrics.total}</div><div class="v">${totals.total}</div></div>
      <div class="metric"><div class="k">${text.metrics.critical}</div><div class="v" style="color:${totals.bySeverity.critical ? SEVERITY_COLOR.critical : 'var(--faint)'}">${totals.bySeverity.critical}</div></div>
      <div class="metric"><div class="k">${text.metrics.high}</div><div class="v" style="color:${totals.bySeverity.high ? SEVERITY_COLOR.high : 'var(--faint)'}">${totals.bySeverity.high}</div></div>
      <div class="metric"><div class="k">${text.metrics.files}</div><div class="v">${fileList.length}</div></div>
    </div>`;

  const distBars = SEVERITY_ORDER.map((sev) => {
    const count = totals.bySeverity[sev];
    const pct = totals.total ? Math.round((count / totals.total) * 100) : 0;
    return `<div class="bar-row">
      <span class="bar-label"><i class="dot" style="background:${SEVERITY_COLOR[sev]}"></i>${text.severity[sev]}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${SEVERITY_COLOR[sev]}"></span></span>
      <span class="bar-value">${count}<em>${pct}%</em></span>
    </div>`;
  }).join('');

  const countedSeverities = SEVERITY_ORDER.filter(
    (sev) => sev !== 'low' && totals.bySeverity[sev] > 0,
  );
  const engineLabel = meta.engineVersion ? `opengrep v${escapeHtml(meta.engineVersion)}` : '—';

  const top5Rows = [...fileList]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(
      (file) => `<tr>
        <td class="path">${pathHtml(file.path, text.unknownPath)}</td>
        <td class="num strong">${file.count}</td>
        ${countedSeverities
          .map((sev) => `<td class="num">${file.bySev[sev] || '—'}</td>`)
          .join('')}
        <td><span class="sev-chip" style="color:#fff;background:${SEVERITY_COLOR[file.maxSeverity]}">${text.severity[file.maxSeverity]}</span></td>
      </tr>`,
    )
    .join('');

  const actionRows = fileList
    .map(
      (file) => `<tr>
        <td class="path">${pathHtml(file.path, text.unknownPath)}<div class="sub-rule">${escapeHtml(file.topRule)}</div></td>
        <td class="num strong">${file.count}</td>
        <td class="num crit">${file.bySev.critical || '—'}</td>
        <td class="num hi">${file.bySev.high || '—'}</td>
        <td class="num mid">${file.bySev.medium || '—'}</td>
        <td class="num low">${file.bySev.low || '—'}</td>
      </tr>`,
    )
    .join('');

  const firstSeverity = SEVERITY_ORDER.find((sev) => current.some((issue) => issue.severity === sev));
  const detailHtml =
    current.length === 0
      ? `<p class="conclusion">${text.noIssues}</p>`
      : SEVERITY_ORDER.map((sev) => {
          const list = current.filter((issue) => issue.severity === sev);
          if (list.length === 0) return '';
          const byFileCount = new Set(list.map((issue) => issue.filePath)).size;
          return detailGroupHtml({
            heading: text.severity[sev],
            sub: text.groupCount(list.length, byFileCount),
            hint: text.groupHint[sev],
            accent: SEVERITY_COLOR[sev],
            first: sev === firstSeverity,
            list,
            snippets,
            snippetBudget,
            text,
            lookup,
          });
        }).join('');

  const fixedHtml = fixed.length
    ? detailGroupHtml({
        heading: text.fixedHeading(fixed.length),
        sub: '',
        accent: '#1e9e6a',
        first: false,
        list: fixed,
        snippets: new Map(),
        snippetBudget: { left: 0 },
        text,
        lookup,
      })
    : '';

  const packsRows =
    meta.rulepacks?.length
      ? meta.rulepacks
          .map(
            (pack) =>
              `<tr><td>${escapeHtml(pack.name)}</td><td class="cell-mono">${escapeHtml(pack.id)}</td></tr>`,
          )
          .join('')
      : meta.importSource === 'sarif'
        ? `<tr><td colspan="2" class="hint">${escapeHtml(text.sarifImport(meta.toolName))}</td></tr>`
        : `<tr><td colspan="2" class="hint">${meta.rules ? escapeHtml(meta.rules) : text.noPacks}</td></tr>`;

  const ruleCards = ruleList
    .map((rule, index) => {
      const note = lang === 'en' ? '' : lookup(rule.id, '');
      return `<div class="rule-card">
      <div class="rule-head">
        <span class="rule-idx">${String(index + 1).padStart(2, '0')}</span>
        <span class="rule-name">${escapeHtml(rule.id)}</span>
        <span class="rule-stat">${text.ruleStat(rule.count, rule.files.size)} · <i class="dot" style="background:${SEVERITY_COLOR[rule.maxSev]}"></i>${text.severity[rule.maxSev]}</span>
      </div>
      ${note ? `<p class="rule-text">${escapeHtml(note)}</p>` : lang !== 'en' ? `<p class="rule-text muted">${text.noMessage}</p>` : ''}
    </div>`;
    })
    .join('');

  const reviewValue = reviewStats ? text.reviewLine(reviewStats) : text.reviewNone;
  const scopeValue = `${text.filesUnit(meta.fileCount)}${meta.language ? ` · ${escapeHtml(meta.language)}` : ''}`;
  const baselineValue = meta.baselineScanId
    ? text.baselineSentence(
        meta.baselineScanId,
        totals.byComparison.new,
        totals.byComparison.remaining,
        totals.byComparison.fixed,
      )
    : text.firstScanNoBaseline;

  return `<!DOCTYPE html>
<html lang="${text.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.docTitle} · ${escapeHtml(meta.projectName)} · ${escapeHtml(meta.scanId)}</title>
<style>
${REPORT_CSS}
</style>
</head>
<body>
<div class="doc">

  <section>
    <div class="cover-top">
      <div>
        <div class="proj">${escapeHtml(meta.projectName)}${meta.projectDescription ? ` · ${escapeHtml(meta.projectDescription)}` : ''}</div>
        <h1>${text.docTitle}</h1>
      </div>
      <div class="doc-meta">
        <b class="mono">${escapeHtml(meta.scanId)}</b><br>
        ${text.meta.finishedAt} <b>${formatDateTime(meta.finishedAt ?? meta.scannedAt)}</b><br>
        ${text.meta.engine} <b>${engineLabel}</b> · ${text.meta.rulesLabel} <b>${meta.importSource === 'sarif' ? escapeHtml(text.sarifImport(meta.toolName)) : escapeHtml(meta.rules ?? '—')}</b>
      </div>
    </div>

    <div class="conclusion"><p>${conclusionText}</p></div>

    ${metricsHtml}

    <h2 class="sec">${text.distTitle}</h2>
    ${distBars}

    <h3 class="sub">${text.top5Title}</h3>
    <p class="hint">${text.top5Hint}</p>
    <table>
      <thead><tr><th>${text.thFile}</th><th class="num">${text.thCount}</th>${countedSeverities.map((sev) => `<th class="num">${text.severity[sev]}</th>`).join('')}<th>${text.thMaxSeverity}</th></tr></thead>
      <tbody>${top5Rows}</tbody>
    </table>

    <dl class="kv" style="margin-top:14px">
      <dt>${text.scopeLabel}</dt><dd>${scopeValue}</dd>
      <dt>${text.baselineLabel}</dt><dd>${escapeHtml(baselineValue)}</dd>
      <dt>${text.distLabel}</dt><dd>${text.distSentence(totals.total, fileList.length, ruleList.length)}</dd>
    </dl>

    <div class="foot"><span>${text.brand}</span><span>${formatDateTime(meta.generatedAt)}</span></div>
  </section>

  <section class="block">
    <h2 class="sec">${text.sections.actions}</h2>
    <p class="hint">${text.actionsHint(fileList.length)}</p>
    <table>
      <thead><tr><th>${text.thFileMainIssue}</th><th class="num">${text.thCount}</th><th class="num">${text.severity.critical}</th><th class="num">${text.severity.high}</th><th class="num">${text.severity.medium}</th><th class="num">${text.severity.low}</th></tr></thead>
      <tbody>${actionRows}</tbody>
    </table>
  </section>

  <section class="block">
    <h2 class="sec">${text.sections.details}</h2>
    ${detailHtml}
  </section>
  ${fixedHtml}

  <section class="flow">
    <h2 class="sec">${text.sections.rulesAppendix}</h2>
    <p class="hint">${text.appendixHint(ruleList.length)}</p>
    ${ruleCards}
  </section>

  <section class="block">
    <h2 class="sec">${text.sections.method}</h2>

    <h3 class="sub">${text.methodSub.packs}</h3>
    <table>
      <thead><tr><th>${text.packThName}</th><th>${text.packThId}</th></tr></thead>
      <tbody>${packsRows}</tbody>
    </table>

    <h3 class="sub">${text.methodSub.repro}</h3>
    <dl class="kv">
      <dt>${text.meta.engine}</dt><dd>${engineLabel}${meta.durationSeconds !== undefined ? ` · ${formatDuration(meta.durationSeconds, text)}` : ''}</dd>
      <dt>${text.meta.sourceHash}</dt><dd class="mono">${escapeHtml(meta.sourceHash ?? '—')}</dd>
      <dt>${text.meta.generatedAt}</dt><dd>${formatDateTime(meta.generatedAt)}</dd>
    </dl>
    ${meta.commandLine ? `<pre class="cmd">${escapeHtml(sanitizeCommand(meta.commandLine))}</pre>` : ''}

    <h3 class="sub">${text.methodSub.review}</h3>
    <dl class="kv">
      <dt>${text.reviewLabel}</dt><dd>${escapeHtml(reviewValue)}</dd>
      <dt>${text.filesChecked}</dt><dd>${text.filesUnit(meta.fileCount)}</dd>
      <dt>${text.methodSub.exclusions}</dt><dd>${text.exclusions}</dd>
      <dt>${text.methodSub.boundaries}</dt><dd>${text.notCovered}</dd>
    </dl>

    <div class="foot"><span>${escapeHtml(meta.projectName)} · ${escapeHtml(meta.scanId)}</span><span>${text.brand}</span></div>
  </section>

</div>
</body>
</html>`;
}
