
export type ReviewStatus = 'pending' | 'confirmed' | 'false_positive' | 'accepted';
type TaintRole = 'source' | 'intermediate' | 'sink';

interface IIssueReview {
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt: string;
}

export interface ITaintStep {
  role: TaintRole;
  path: string;
  line: number;
  col?: number;
  text?: string;
}

export interface IIssue {
  id: string;
  scanId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  comparisonStatus: 'new' | 'fixed' | 'remaining';
  ruleId: string;
  message: string;
  filePath: string;
  startLine: number;
  endLine: number;
  fingerprint?: string;
  taintFlow?: ITaintStep[];
  review?: IIssueReview;
  rulepackId?: string;
  rulepackName?: string;
}

export const REVIEW_BADGE_CLASS: Record<ReviewStatus, string> = {
  pending: 'border-border bg-muted text-muted-foreground',
  confirmed: 'border-destructive/40 bg-destructive/10 text-destructive',
  false_positive: 'border-success/40 bg-success/10 text-success',
  accepted: 'border-warning/40 bg-warning/10 text-warning',
};

export const MOCK_ISSUES: IIssue[] = [
  {
    id: '1',
    scanId: '2',
    severity: 'critical',
    comparisonStatus: 'remaining',
    ruleId: 'G401',
    message: '使用弱哈希算法 MD5 存储密码',
    filePath: 'src/utils/crypto.ts',
    startLine: 44,
    endLine: 44,
    fingerprint: 'G401:src/utils/crypto.ts:44',
  },
  {
    id: '2',
    scanId: '2',
    severity: 'critical',
    comparisonStatus: 'new',
    ruleId: 'G201',
    message: 'SQL 语句拼接，存在注入风险',
    filePath: 'src/api/user.ts',
    startLine: 16,
    endLine: 17,
    fingerprint: 'G201:src/api/user.ts:16',
  },
  {
    id: '3',
    scanId: '2',
    severity: 'high',
    comparisonStatus: 'new',
    ruleId: 'G101',
    message: '检测到硬编码的 API Key',
    filePath: 'src/config/env.ts',
    startLine: 9,
    endLine: 9,
    fingerprint: 'G101:src/config/env.ts:9',
  },
  {
    id: '4',
    scanId: '2',
    severity: 'medium',
    comparisonStatus: 'remaining',
    ruleId: 'G112',
    message: '文件路径未校验，存在路径遍历风险',
    filePath: 'src/utils/file.ts',
    startLine: 27,
    endLine: 30,
    fingerprint: 'G112:src/utils/file.ts:27',
  },
  {
    id: '5',
    scanId: '2',
    severity: 'high',
    comparisonStatus: 'fixed',
    ruleId: 'G501',
    message: '不安全的随机数生成器',
    filePath: 'src/utils/random.ts',
    startLine: 12,
    endLine: 14,
    fingerprint: 'G501:src/utils/random.ts:12',
  },
  {
    id: '6',
    scanId: '1',
    severity: 'low',
    comparisonStatus: 'remaining',
    ruleId: 'G104',
    message: '异常被静默忽略，缺少错误处理',
    filePath: 'src/api/order.ts',
    startLine: 51,
    endLine: 53,
    fingerprint: 'G104:src/api/order.ts:51',
  },
];

export function mockIssuesForScan(scanId: string): IIssue[] {
  const matched = MOCK_ISSUES.filter((issue) => issue.scanId === scanId);
  if (matched.length > 0) return matched;
  return MOCK_ISSUES
    .filter((issue) => issue.scanId === '2')
    .map((issue) => ({ ...issue, scanId }));
}

export function mockIssueFingerprint(issue: IIssue): string {
  return issue.fingerprint ?? `${issue.ruleId}:${issue.filePath}:${issue.startLine}`;
}
