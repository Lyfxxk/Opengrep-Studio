import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type BatchEntity = 'project' | 'scan' | 'config' | 'rulePack';

export default function BatchDeleteBar({ count, entity, deleting, onDelete, onClear }: {
  count: number;
  entity: BatchEntity;
  deleting: boolean;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5">
      <span className="text-sm font-medium">
        {t('batch.barSelected', { count, entity: t(`entity.${entity}`, { count }) })}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" className="gap-1" disabled={deleting} onClick={onClear}>
          {t('batch.clearSelection')}
        </Button>
        <Button variant="destructive" size="sm" className="gap-1" disabled={deleting} onClick={onDelete}>
          <Trash2 className="size-3.5" />
          {t('batch.deleteButton')}
        </Button>
      </div>
    </div>
  );
}
