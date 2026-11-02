import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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

export function BatchDeleteConfirm({ open, entity, count, extra, onOpenChange, onConfirm }: {
  open: boolean;
  entity: BatchEntity;
  count: number;
  extra?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const entityLabel = t(`entity.${entity}`, { count });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('batch.confirmTitle', { count, entity: entityLabel })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('batch.confirmDesc', { count, entity: entityLabel, extra: extra ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('common.confirmDelete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
