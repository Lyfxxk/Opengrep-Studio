import { CircleAlert, CheckCircle2, CircleDot } from 'lucide-react';

export const LIST_PAGE_SIZE = 10;

export const PACK_LANGUAGES = [
  'Java',
  'JavaScript',
  'TypeScript',
  'Go',
  'Python',
  'C',
  'C++',
  'C#',
  'PHP',
  'Ruby',
  'Rust',
  'Kotlin',
  'Swift',
  'Dockerfile',
  'Other',
] as const;

export const COMPARISON_VISUALS: Record<
  'new' | 'fixed' | 'remaining',
  { icon: typeof CircleAlert; tone: string; bg: string; badge: string }
> = {
  new: {
    icon: CircleAlert,
    tone: 'text-destructive',
    bg: 'bg-destructive/10',
    badge: 'bg-destructive/15 text-destructive border-transparent',
  },
  fixed: {
    icon: CheckCircle2,
    tone: 'text-success',
    bg: 'bg-success/10',
    badge: 'bg-success/15 text-success border-transparent',
  },
  remaining: {
    icon: CircleDot,
    tone: 'text-warning',
    bg: 'bg-warning/10',
    badge: 'bg-warning/15 text-warning border-transparent',
  },
};
