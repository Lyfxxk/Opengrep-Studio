import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { IProject } from '@/data/projects';

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    values: { name: string; description: string },
    projectId?: string,
  ) => void;
  project?: IProject | null;
}

export default function NewProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  project,
}: NewProjectDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const isEditing = Boolean(project);

  useEffect(() => {
    if (open) {
      setName(project?.name ?? '');
      setDescription(project?.description ?? '');
      setError('');
    }
  }, [open, project]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入项目名称');
      return;
    }
    if (trimmed.length > 50) {
      setError('项目名称不能超过 50 个字符');
      return;
    }
    onSubmit({ name: trimmed, description: description.trim() }, project?.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑项目' : '新建项目'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="project-name">项目名称 *</Label>
            <Input
              id="project-name"
              value={name}
              maxLength={50}
              placeholder="例如：订单服务重构"
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-desc">项目描述</Label>
            <Textarea
              id="project-desc"
              value={description}
              maxLength={200}
              rows={3}
              placeholder="选填，说明本次审查范围与目标"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit}>{isEditing ? '保存修改' : '创建项目'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
