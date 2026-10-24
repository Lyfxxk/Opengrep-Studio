import { useEffect, useState } from 'react';
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
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!open || !pack) return;
    setEditing(false);
    setLoading(true);
    api
      .getRulePackContent(pack.id)
      .then((data) => setContent(data.content))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
        onOpenChange(false);
      })
      .finally(() => setLoading(false));
  }, [open, pack, onOpenChange]);

  const handleSave = async () => {
    if (!pack) return;
    setSaving(true);
    try {
      await api.updateRulePackContent(pack.id, content);
      toast.success(`规则包「${pack.name}」已保存`);
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
            {readOnly ? '内置规则包（只读）' : '规则包内容'}
            {pack && <Badge variant="secondary" className="font-normal">{pack.language}</Badge>}
            {pack && (
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {pack.ruleCount} 条规则
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取规则内容…
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
            {content || '（空）'}
          </pre>
        )}

        <DialogFooter className="items-center">
          {readOnly && (
            <span className="mr-auto text-xs text-muted-foreground">
              内置规则包随项目分发，仅供查看与启停；如需更新请通过 server/scripts 维护
            </span>
          )}
          {editing ? (
            <>
              <Button variant="outline" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button className="gap-1" disabled={saving} onClick={() => void handleSave()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {saving ? '保存中…' : '保存修改'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              {!readOnly && (
                <Button className="gap-1" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" />
                  编辑
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
