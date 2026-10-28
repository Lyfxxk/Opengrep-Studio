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

/** 轻量分页条：上一页 / 页码 / 下一页。列表页与问题列表共用 */
export default function Pagination({ page, pageCount, onPage, className }: PaginationProps) {
  const { t } = useTranslation();
  if (pageCount <= 1) return null;
  return (
    <nav className={cn('flex items-center justify-end gap-1', className)} aria-label="pagination">
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
      <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
        {t('pagination.pageOf', { page, total: pageCount })}
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
