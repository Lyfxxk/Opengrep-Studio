import { format } from 'date-fns';

/** 短日期时间（列表 / 卡片通用）：`2026-10-24 18:30`；无效或缺失返回占位符 */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format(date, 'yyyy-MM-dd HH:mm');
}

/** 引擎耗时（秒 → `45 秒` / `3 分 12 秒`）；无效值返回占位符 */
export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
