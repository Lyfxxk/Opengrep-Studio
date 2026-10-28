import type { IIssue } from '@/data/issues';

/** 严重度从高到低的唯一展示顺序（仪表盘 / 报告 / 结果页共用） */
export const SEVERITY_ORDER: Array<IIssue['severity']> = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_BADGE_CLASS: Record<IIssue['severity'], string> = {
  critical: 'bg-destructive/15 text-destructive border-transparent',
  high: 'bg-warning/15 text-warning border-transparent',
  medium: 'bg-primary/10 text-primary border-transparent',
  low: 'bg-muted text-muted-foreground border-transparent',
};

/** 严重度条形图的填充色（仪表盘风险分布 / 报告页分布条共用） */
export const SEVERITY_BAR_CLASS: Record<IIssue['severity'], string> = {
  critical: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-primary',
  low: 'bg-muted-foreground/40',
};

/** 严重度左侧色条（报告页明细分组标题、文件头共用） */
export const SEVERITY_BORDER_CLASS: Record<IIssue['severity'], string> = {
  critical: 'border-destructive',
  high: 'border-warning',
  medium: 'border-primary',
  low: 'border-muted-foreground/40',
};

/** 严重度文字色（报告页统计与标注共用） */
export const SEVERITY_TEXT_CLASS: Record<IIssue['severity'], string> = {
  critical: 'text-destructive',
  high: 'text-warning',
  medium: 'text-primary',
  low: 'text-muted-foreground',
};
