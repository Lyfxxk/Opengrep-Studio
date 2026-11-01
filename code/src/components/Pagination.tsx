import { useTranslation } from 'react-i18next';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  className?: string;
}

const EDGE_BUTTON = 'h-7 w-7 shrink-0 p-0';
const STEP_BUTTON = 'h-7 shrink-0 gap-1 px-2';

export default function Pagination({ page, pageCount, onPage, className }: PaginationProps) {
  const { t } = useTranslation();
  if (pageCount <= 1) return null;

  const jumpTo = (raw: string): boolean => {
    const target = Number(raw);
    if (!Number.isInteger(target) || target < 1 || target > pageCount) return false;
    if (target !== page) onPage(target);
    return true;
  };

  return (
    <nav
      className={cn('flex items-center justify-center gap-1.5 text-xs', className)}
      aria-label={t('pagination.aria')}
    >
      <Button
        variant="outline"
        size="sm"
        className={EDGE_BUTTON}
        disabled={page <= 1}
        onClick={() => onPage(1)}
        title={t('pagination.first')}
        aria-label={t('pagination.first')}
      >
        <ChevronFirst className="size-3.5" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className={STEP_BUTTON}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft className="size-3.5" />
        {t('pagination.prev')}
      </Button>
      <span className="flex shrink-0 items-center gap-1 px-1 text-muted-foreground">
        <span>{t('pagination.pagePrefix')}</span>
        {}
        <input
          key={page}
          type="text"
          inputMode="numeric"
          defaultValue={page}
          aria-label={t('pagination.pageOf', { page, total: pageCount })}
          style={{ width: `calc(${Math.max(1, String(pageCount).length)}ch + 0.75rem)` }}
          className="h-7 rounded-md border border-input bg-muted/40 px-1 text-center tabular-nums text-foreground outline-none transition-colors hover:bg-muted focus:border-primary focus:bg-background focus:ring-2 focus:ring-ring/30"
          onFocus={(event) => event.currentTarget.select()}
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
        <span className="tabular-nums">{t('pagination.pageSuffix', { total: pageCount })}</span>
      </span>
      <Button
        variant="outline"
        size="sm"
        className={STEP_BUTTON}
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {t('pagination.next')}
        <ChevronRight className="size-3.5" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className={EDGE_BUTTON}
        disabled={page >= pageCount}
        onClick={() => onPage(pageCount)}
        title={t('pagination.last')}
        aria-label={t('pagination.last')}
      >
        <ChevronLast className="size-3.5" />
      </Button>
    </nav>
  );
}
