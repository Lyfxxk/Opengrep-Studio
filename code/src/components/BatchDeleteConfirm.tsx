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

/** 批量删除确认框：与单条删除的 AlertDialog 同款视觉 */
export default function BatchDeleteConfirm({ open, label, count, extra, onOpenChange, onConfirm }: {
  open: boolean;
  label: string;
  count: number;
  /** 追加在确认文案后的补充说明（如配置解绑提示） */
  extra?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除 {count} 个{label}</AlertDialogTitle>
          <AlertDialogDescription>
            已选中的 {count} 个{label}将被删除，此操作不可恢复。{extra ?? ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>确认删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
