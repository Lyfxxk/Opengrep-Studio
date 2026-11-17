import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface ListStatusBlockProps {
  rowCount: number | null;
  filteredCount: number;
  loadFailed: boolean;
  onRetry: () => void;
  emptyState: ReactNode;
  filterEmptyText: string;
  children: ReactNode;
}

export default function ListStatusBlock({
  rowCount,
  filteredCount,
  loadFailed,
  onRetry,
  emptyState,
  filterEmptyText,
  children,
}: ListStatusBlockProps) {
  const { t } = useTranslation();
  const retry = (
    <button
      type="button"
      className="ml-2 font-medium text-primary hover:underline"
      onClick={onRetry}
    >
      {t('common.retry')}
    </button>
  );
  return (
    <>
      {loadFailed && rowCount !== null && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-muted-foreground">
          {t('common.loadFailedHint')}
          {retry}
        </div>
      )}
      {rowCount === null ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {loadFailed ? (
            <>
              {t('common.loadFailedHint')}
              {retry}
            </>
          ) : (
            t('common.loading')
          )}
        </div>
      ) : filteredCount === 0 && rowCount === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {emptyState}
        </div>
      ) : filteredCount === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filterEmptyText}
        </div>
      ) : (
        children
      )}
    </>
  );
}