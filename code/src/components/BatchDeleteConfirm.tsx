import { useTranslation } from 'react-i18next';
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
import type { BatchEntity } from '@/components/BatchDeleteBar';

/** 批量删除确认框：与单条删除的 AlertDialog 同款视觉 */
export default function BatchDeleteConfirm({ open, entity, count, extra, onOpenChange, onConfirm }: {
  open: boolean;
  entity: BatchEntity;
  count: number;
  /** 追加在确认文案后的补充说明（如配置解绑提示），由调用方自行翻译 */
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
