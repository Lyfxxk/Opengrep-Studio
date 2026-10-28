import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Pencil, Save } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { IRulePack } from '@/data/rulepacks';
import { api } from '@/lib/api';

interface RulePackContentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pack: IRulePack | null;
  onSaved: () => void;
}

export default function RulePackContentDialog({
  open,
  onOpenChange,
  pack,
  onSaved,
}: RulePackContentDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!open || !pack) return;
    // 竞态守卫：切换包时晚到的旧响应不得覆盖新包内容
    let cancelled = false;
    setEditing(false);
    setLoading(true);
    api
      .getRulePackContent(pack.id)
      .then((data) => {
        if (!cancelled) setContent(data.content);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toast.error(error instanceof Error ? error.message : String(error));
        onOpenChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pack, onOpenChange]);

  const handleSave = async () => {
    if (!pack) return;
    setSaving(true);
    try {
      await api.updateRulePackContent(pack.id, content);
      toast.success(t('rulePacks.savedToast', { name: pack.name }));
      setEditing(false);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const readOnly = pack?.builtin ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {readOnly ? t('rulePacks.builtinReadOnlyTitle') : t('rulePacks.contentTitle')}
            {pack && <Badge variant="secondary" className="font-normal">{pack.language}</Badge>}
            {pack && (
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {t('configs.ruleCount', { count: pack.ruleCount })}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('rulePacks.contentLoading')}
          </div>
        ) : editing ? (
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            className="h-[50vh] shrink-0 overflow-y-auto font-mono text-xs leading-5"
            placeholder={'rules:\n  - id: my-rule\n    languages: [javascript]\n    ...'}
          />
        ) : (
          <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-5">
            {content || t('rulePacks.emptyContent')}
          </pre>
        )}

        <DialogFooter className="items-center">
          {readOnly && (
            <span className="mr-auto text-xs text-muted-foreground">
              {t('rulePacks.builtinContentHint')}
            </span>
          )}
          {editing ? (
            <>
              <Button variant="outline" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
              <Button className="gap-1" disabled={saving} onClick={() => void handleSave()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {saving ? t('rulePacks.saving') : t('configs.save')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
              {!readOnly && (
                <Button className="gap-1" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" />
                  {t('common.edit')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
