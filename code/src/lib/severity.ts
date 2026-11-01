import type { IIssue } from '@/data/issues';

export const SEVERITY_ORDER: Array<IIssue['severity']> = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_BADGE_CLASS: Record<IIssue['severity'], string> = {
  critical: 'bg-destructive/15 text-destructive border-transparent',
  high: 'bg-warning/15 text-warning border-transparent',
  medium: 'bg-primary/10 text-primary border-transparent',
  low: 'bg-muted text-muted-foreground border-transparent',
};

export const SEVERITY_BAR_CLASS: Record<IIssue['severity'], string> = {
  critical: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-primary',
  low: 'bg-muted-foreground/40',
};

export const SEVERITY_BORDER_CLASS: Record<IIssue['severity'], string> = {
  critical: 'border-destructive',
  high: 'border-warning',
  medium: 'border-primary',
  low: 'border-muted-foreground/40',
};

export const SEVERITY_TEXT_CLASS: Record<IIssue['severity'], string> = {
  critical: 'text-destructive',
  high: 'text-warning',
  medium: 'text-primary',
  low: 'text-muted-foreground',
};
