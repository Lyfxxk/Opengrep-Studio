import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      setError(t('rulePacks.nameRequired'));
      return;
    }
    if (!content.trim()) {
      setError(t('rulePacks.contentRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const pack = await api.createRulePack(trimmed, language, content);
      toast.success(t('rulePacks.createdToast', { name: pack.name, count: pack.ruleCount }));
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
          <DialogTitle>{t('rulePacks.createBtn')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rulepack-create-name">{t('rulePacks.uploadNameLabel')}</Label>
              <Input
                id="rulepack-create-name"
                value={name}
                maxLength={50}
                placeholder={t('rulePacks.createNamePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value);
                  setError('');
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('rulePacks.uploadLangLabel')}</Label>
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
            <Label htmlFor="rulepack-create-content">{t('rulePacks.contentLabel')}</Label>
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
            {t('common.cancel')}
          </Button>
          <Button className="gap-1" disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {submitting ? t('rulePacks.creating') : t('rulePacks.createSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
