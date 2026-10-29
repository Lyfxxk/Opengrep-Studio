import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PaginationProps {
  /** 当前页（1 起） */
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  className?: string;
}

/** 轻量分页条：上一页 / 页码（可直接输入跳转）/ 下一页。列表页与问题列表共用 */
export default function Pagination({ page, pageCount, onPage, className }: PaginationProps) {
  const { t } = useTranslation();
  if (pageCount <= 1) return null;
  // 结算手输页码：合法则翻页（返回 true），非法/越界返回 false 由调用方把输入回落回当前页
  const jumpTo = (raw: string): boolean => {
    const target = Number(raw);
    if (!Number.isInteger(target) || target < 1 || target > pageCount) return false;
    if (target !== page) onPage(target);
    return true;
  };
  return (
    <nav className={cn('flex items-center justify-center gap-1', className)} aria-label="pagination">
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft className="size-3.5" />
        {t('pagination.prev')}
      </Button>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>{t('pagination.pagePrefix')}</span>
        {/* 非受控 + key={page}：外部翻页（上下页、筛选重置页码）时重挂载回显新页码，
            避免受控 state 与 onPage 双向打抖；回车即结算，不依赖元素是否真的拿到焦点 */}
        <input
          key={page}
          type="text"
          inputMode="numeric"
          defaultValue={page}
          aria-label={t('pagination.pageOf', { page, total: pageCount })}
          className="h-7 w-11 rounded-md border border-input bg-transparent px-1 text-center text-xs tabular-nums text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          onChange={(event) => {
            const digits = event.currentTarget.value.replace(/\D/g, '');
            if (digits !== event.currentTarget.value) event.currentTarget.value = digits;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            if (jumpTo(event.currentTarget.value)) event.currentTarget.blur();
            else event.currentTarget.value = String(page);
          }}
          onBlur={(event) => {
            if (!jumpTo(event.currentTarget.value)) event.currentTarget.value = String(page);
          }}
        />
        <span>{t('pagination.pageSuffix', { total: pageCount })}</span>
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t('pagination.next')}
        <ChevronRight className="size-3.5" />
      </Button>
    </nav>
  );
}
