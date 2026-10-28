import { format } from 'date-fns';
import i18n from '@/i18n';

/** 短日期时间（列表 / 卡片通用）：`2026-10-24 18:30`；无效或缺失返回占位符 */
export function formatDateTime(iso?: string | null, options?: { withSeconds?: boolean }): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return format(date, options?.withSeconds ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm');
}

/** 引擎耗时（秒 → `45 秒` / `3 分 12 秒`）；无效值返回占位符 */
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
