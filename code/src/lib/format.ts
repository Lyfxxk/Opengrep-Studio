import { format } from 'date-fns';
import i18n from '@/i18n';

export function formatDateTime(iso?: string | null, options?: { withSeconds?: boolean }): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return format(date, options?.withSeconds ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm');
}

export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  if (seconds < 60) return i18n.t('format.durationSeconds', { count: seconds });
  return i18n.t('format.durationMinutes', {
    min: Math.floor(seconds / 60),
    sec: seconds % 60,
  });
}
