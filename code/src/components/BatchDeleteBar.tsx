import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** 批量删除组件共用的实体名（i18n entity.* 键尾段；文案改动改 i18n 资源） */
export type BatchEntity = 'project' | 'scan' | 'config' | 'rulePack';

/** 批量操作条：勾选 > 0 时出现在列表上方，提供批量删除与取消选择 */
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
