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
import { REVIEW_STATUS_LABELS, type IIssue, type ReviewStatus } from '@/data/issues';
import { getCurrentUsername } from '@/lib/auth';
import { api } from '@/lib/api';

interface ReviewDialogProps {
  projectId: string;
  issue: IIssue | null;
  onClose: () => void;
  onSaved: () => void;
}

const STATUS_OPTIONS: Array<{ value: 'confirmed' | 'false_positive' | 'accepted'; hint: string }> = [
  { value: 'confirmed', hint: '核实为真实风险，需要修复' },
  { value: 'false_positive', hint: '误报，说明依据后可忽略' },
  { value: 'accepted', hint: '真实风险但暂不修复，记录理由' },
];

/** 人工复核对话框：结论以 (项目, fingerprint) 落库，后续扫描自动继承 */
export default function ReviewDialog({ projectId, issue, onClose, onSaved }: ReviewDialogProps) {
  const [status, setStatus] = useState<ReviewStatus>('confirmed');
  const [reason, setReason] = useState('');
  const [reviewer, setReviewer] = useState(getCurrentUsername());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (issue) {
      setStatus(issue.review?.status ?? 'confirmed');
      setReason(issue.review?.reason ?? '');
      setReviewer(issue.review?.reviewer ?? getCurrentUsername());
    }
  }, [issue]);

  const submit = async () => {
    if (!issue?.fingerprint) {
      toast.error('该问题缺少指纹，无法复核（旧扫描记录），请重新扫描后再试');
      return;
    }
    if (status !== 'confirmed' && !reason.trim()) {
      toast.error('判定误报/有条件接受时请填写理由，作为审计证据');
      return;
    }
    setSubmitting(true);
    try {
      await api.setReview(projectId, issue.fingerprint, {
        status: status as 'confirmed' | 'false_positive' | 'accepted',
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        reviewer: reviewer.trim() || undefined,
      });
      toast.success('复核结论已保存，后续扫描将自动继承');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={issue !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>人工复核</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <p className="truncate font-mono text-muted-foreground" title={issue?.filePath ?? ''}>
              {issue?.filePath}:{issue?.startLine}
            </p>
            <p className="mt-1 font-mono text-muted-foreground">{issue?.ruleId}</p>
          </div>
          <div className="space-y-2">
            <Label>复核结论</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as ReviewStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {REVIEW_STATUS_LABELS[option.value]}
                    <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="review-reason">
              复核理由{status !== 'confirmed' ? '（必填，写入审计证据）' : '（可选）'}
            </Label>
            <Textarea
              id="review-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder="例如：该接口仅内网可达且入口已做白名单校验，判定为误报"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="review-reviewer">复核人</Label>
            <Input
              id="review-reviewer"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
              maxLength={100}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button className="gap-1" disabled={submitting} onClick={() => void submit()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            保存复核结论
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
