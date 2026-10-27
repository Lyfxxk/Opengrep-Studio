import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** 批量操作条：勾选 > 0 时出现在列表上方，提供批量删除与取消选择 */
export default function BatchDeleteBar({ count, label, deleting, onDelete, onClear }: {
  count: number;
  label: string;
  deleting: boolean;
  onDelete: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5">
      <span className="text-sm font-medium">已选 {count} 个{label}</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" className="gap-1" disabled={deleting} onClick={onClear}>
          取消选择
        </Button>
        <Button variant="destructive" size="sm" className="gap-1" disabled={deleting} onClick={onDelete}>
          <Trash2 className="size-3.5" />
          批量删除
        </Button>
      </div>
    </div>
  );
}
