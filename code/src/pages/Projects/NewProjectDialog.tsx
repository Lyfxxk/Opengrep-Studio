import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  ) => void | Promise<void>;
  project?: IProject | null;
}

export default function NewProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  project,
}: NewProjectDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isEditing = Boolean(project);

  useEffect(() => {
    if (open) {
      setName(project?.name ?? '');
      setDescription(project?.description ?? '');
      setError('');
      setSubmitting(false);
    }
  }, [open, project]);

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('projects.nameRequired'));
      return;
    }
    if (trimmed.length > 50) {
      setError(t('projects.nameTooLong'));
      return;
    }
    // 等父组件保存完成再复位：否则双击会发出两次创建请求
    setSubmitting(true);
    try {
      await onSubmit({ name: trimmed, description: description.trim() }, project?.id);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('projects.editTitle') : t('projects.newProject')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="project-name">{t('projects.nameLabel')}</Label>
            <Input
              id="project-name"
              value={name}
              maxLength={50}
              placeholder={t('projects.namePlaceholder')}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-desc">{t('projects.descLabel')}</Label>
            <Textarea
              id="project-desc"
              value={description}
              maxLength={200}
              rows={3}
              placeholder={t('projects.descPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {isEditing ? t('projects.save') : t('projects.createSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
