import type { IIssue } from '@/data/issues';

export const SEVERITY_BADGE_CLASS: Record<IIssue['severity'], string> = {
  critical: 'bg-destructive/15 text-destructive border-transparent',
  high: 'bg-warning/15 text-warning border-transparent',
  medium: 'bg-primary/10 text-primary border-transparent',
  low: 'bg-muted text-muted-foreground border-transparent',
};

export const COMPARISON_BADGE_CLASS: Record<IIssue['comparisonStatus'], string> = {
  new: 'bg-destructive/15 text-destructive border-transparent',
  fixed: 'bg-success/15 text-success border-transparent',
  remaining: 'bg-warning/15 text-warning border-transparent',
};
