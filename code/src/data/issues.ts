
export type ReviewStatus = 'pending' | 'confirmed' | 'false_positive' | 'accepted';
export type TaintRole = 'source' | 'intermediate' | 'sink';

export interface IIssueReview {
  status: ReviewStatus;
  reason?: string;
  reviewer?: string;
  updatedAt: string;
}

/** 污点传播链的一步（source → intermediate… → sink） */
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
  /** 问题指纹（人工复核与跨扫描继承的键，旧记录可能没有） */
  fingerprint?: string;
  /** taint 规则命中的污点传播链 */
  taintFlow?: ITaintStep[];
  /** 人工复核结论（以项目为域跨扫描继承，待复核时不返回） */
  review?: IIssueReview;
  /** 命中规则所属的规则包（快照，旧记录可能没有） */
  rulepackId?: string;
  rulepackName?: string;
}

export const SEVERITY_LABELS: Record<IIssue['severity'], string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
};

export const COMPARISON_LABELS: Record<IIssue['comparisonStatus'], string> = {
  new: '新增',
  fixed: '已修复',
  remaining: '遗留',
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: '待复核',
  confirmed: '已确认',
  false_positive: '误报',
  accepted: '已接受',
};

export const REVIEW_BADGE_CLASS: Record<ReviewStatus, string> = {
  pending: 'border-border bg-muted text-muted-foreground',
  confirmed: 'border-destructive/40 bg-destructive/10 text-destructive',
  false_positive: 'border-success/40 bg-success/10 text-success',
  accepted: 'border-warning/40 bg-warning/10 text-warning',
};

export const TAINT_ROLE_LABELS: Record<TaintRole, string> = {
  source: '污点源',
  intermediate: '传播',
  sink: '汇聚点',
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
  },
];
