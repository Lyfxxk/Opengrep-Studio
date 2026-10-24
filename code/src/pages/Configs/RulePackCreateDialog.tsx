import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PACK_LANGUAGES } from '@/data/constants';
import { api } from '@/lib/api';

const YAML_TEMPLATE = `rules:
  - id: my-first-rule
    languages: [javascript]
    message: 在这里写规则说明
    severity: WARNING
    pattern: eval(...)
`;

interface RulePackCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export default function RulePackCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: RulePackCreateDialogProps) {
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('Java');
  const [content, setContent] = useState(YAML_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setLanguage('Java');
      setContent(YAML_TEMPLATE);
      setError('');
    }
  }, [open]);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入规则包名称');
      return;
    }
    if (!content.trim()) {
      setError('请输入规则包 YAML 内容');
      return;
    }
    setSubmitting(true);
    try {
      const pack = await api.createRulePack(trimmed, language, content);
      toast.success(`规则包「${pack.name}」已创建，解析到 ${pack.ruleCount} 条规则`);
      onOpenChange(false);
      onCreated();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建规则包</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rulepack-create-name">规则包名称</Label>
              <Input
                id="rulepack-create-name"
                value={name}
                maxLength={50}
                placeholder="例如：Java 安全规范"
                onChange={(event) => {
                  setName(event.target.value);
                  setError('');
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>适用语言</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PACK_LANGUAGES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rulepack-create-content">规则 YAML 内容</Label>
            <Textarea
              id="rulepack-create-content"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setError('');
              }}
              rows={14}
              spellCheck={false}
              className="max-h-[50vh] overflow-y-auto font-mono text-xs leading-5"
            />
          </div>
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="gap-1" disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {submitting ? '创建中…' : '创建规则包'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
