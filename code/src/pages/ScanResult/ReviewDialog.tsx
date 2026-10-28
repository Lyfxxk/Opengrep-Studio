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
import { REVIEW_BADGE_CLASS, type IIssue, type ReviewStatus } from '@/data/issues';
import { getCurrentUsername } from '@/lib/auth';
import { api } from '@/lib/api';

interface ReviewDialogProps {
  projectId: string;
  issue: IIssue | null;
  onClose: () => void;
  onSaved: () => void;
}

type ReviewableStatus = 'confirmed' | 'false_positive' | 'accepted';

const STATUS_OPTIONS: Array<{ value: ReviewableStatus; hintKey: 'review.hintConfirmed' | 'review.hintFalsePositive' | 'review.hintAccepted' }> = [
  { value: 'confirmed', hintKey: 'review.hintConfirmed' },
  { value: 'false_positive', hintKey: 'review.hintFalsePositive' },
  { value: 'accepted', hintKey: 'review.hintAccepted' },
];

/** 人工复核对话框：结论以 (项目, fingerprint) 落库，后续扫描自动继承 */
export default function ReviewDialog({ projectId, issue, onClose, onSaved }: ReviewDialogProps) {
  const { t } = useTranslation();
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
      toast.error(t('review.fingerprintMissing'));
      return;
    }
    if (status !== 'confirmed' && !reason.trim()) {
      toast.error(t('review.reasonRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await api.setReview(projectId, issue.fingerprint, {
        status: status as ReviewableStatus,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        reviewer: reviewer.trim() || undefined,
      });
      toast.success(t('review.savedToast'));
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
          <DialogTitle>{t('review.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <p className="truncate font-mono text-muted-foreground" title={issue?.filePath ?? ''}>
              {issue?.filePath}:{issue?.startLine}
            </p>
            <p className="mt-1 font-mono text-muted-foreground">{issue?.ruleId}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('review.verdictLabel')}</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as ReviewStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(`reviewStatus.${option.value}`)}
                    <span className="ml-2 text-xs text-muted-foreground">{t(option.hintKey)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="review-reason">
              {t('review.reasonLabel')}
              {status !== 'confirmed' ? t('review.reasonRequiredSuffix') : t('review.reasonOptionalSuffix')}
            </Label>
            <Textarea
              id="review-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder={t('review.reasonPlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="review-reviewer">{t('review.reviewerLabel')}</Label>
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
            {t('common.cancel')}
          </Button>
          <Button className="gap-1" disabled={submitting} onClick={() => void submit()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {t('review.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
