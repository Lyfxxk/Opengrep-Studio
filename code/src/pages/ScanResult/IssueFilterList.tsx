import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Search, ShieldCheck, XCircle } from 'lucide-react';
import { LIST_PAGE_SIZE } from '@/data/constants';
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import Pagination from '@/components/Pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { REVIEW_BADGE_CLASS, type IIssue } from '@/data/issues';
import { COMPARISON_VISUALS } from '@/data/constants';
import { lookupRuleMessage, useRuleMessageMap } from '@/lib/ruleMessages';
import { SEVERITY_BADGE_CLASS, SEVERITY_ORDER } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { usePackDisplayName } from '@/lib/displayNames';
import { usePagedList, useRowSelection } from '@/lib/usePagedList';
import { api } from '@/lib/api';
import { getCurrentUsername } from '@/lib/auth';
import { KnowledgeLink } from './KnowledgeSheet';

interface IssueFilterListProps {
  projectId: string;
  issues: IIssue[];
  selectedIssueId: string | null;
  canReview: boolean;
  onSelect: (issueId: string) => void;
  onOpenKnowledge?: (ruleId: string) => void;
  onReviewed?: () => void;
}

export default function IssueFilterList({
  projectId,
  issues,
  selectedIssueId,
  canReview,
  onSelect,
  onOpenKnowledge,
  onReviewed,
}: IssueFilterListProps) {
  const { t } = useTranslation();
  const [severity, setSeverity] = useState('all');
  const [status, setStatus] = useState('all');
  const [keyword, setKeyword] = useState('');
  const messageMap = useRuleMessageMap();
  const packDisplayName = usePackDisplayName();

  const [batchDialog, setBatchDialog] = useState<{ status: 'confirmed' | 'false_positive' } | null>(null);
  const [batchReason, setBatchReason] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  const filtered = useMemo(
    () =>
      issues.filter((issue) => {
        if (severity !== 'all' && issue.severity !== severity) return false;
        if (status !== 'all' && issue.comparisonStatus !== status) return false;
        const keywordTrimmed = keyword.trim().toLowerCase();
        if (keywordTrimmed === '') return true;
        const translated = lookupRuleMessage(messageMap, issue.ruleId, '');
        return (
          issue.ruleId.toLowerCase().includes(keywordTrimmed) ||
          issue.filePath.toLowerCase().includes(keywordTrimmed) ||
          issue.message.toLowerCase().includes(keywordTrimmed) ||
          translated.toLowerCase().includes(keywordTrimmed)
        );
      }),
    [issues, severity, status, keyword, messageMap],
  );

  const selection = useRowSelection(filtered.map((issue) => issue.id));

  const hasActiveFilter =
    severity !== 'all' || status !== 'all' || keyword.trim() !== '';
  const resetFilters = () => {
    setSeverity('all');
    setStatus('all');
    setKeyword('');
  };

  const { page: safePage, setPage, pageCount, slice: paged } = usePagedList(filtered, LIST_PAGE_SIZE);

  const handleBatchReview = async () => {
    if (!batchDialog) return;
    const { status } = batchDialog;
    const reason = batchReason.trim() || undefined;
    const selectedIssues = filtered.filter(
      (issue) => selection.selected.has(issue.id) && issue.fingerprint,
    );
    setBatchDialog(null);
    setBatchSubmitting(true);
    let failed = 0;
    for (const issue of selectedIssues) {
      try {
        await api.setReview(projectId, issue.fingerprint!, { status, reason, reviewer: getCurrentUsername() });
      } catch {
        failed += 1;
      }
    }
    setBatchSubmitting(false);
    selection.clear();
    setBatchReason('');
    onReviewed?.();
    if (failed > 0) toast.warning(t('issueFilter.batchPartial', { count: selectedIssues.length - failed, failed }));
  };

  const listRef = useRef<HTMLDivElement>(null);
  const moveSelection = useCallback(
    (offset: 1 | -1) => {
      if (filtered.length === 0) return;
      const currentIndex = filtered.findIndex((issue) => issue.id === selectedIssueId);
      const nextIndex =
        currentIndex === -1
          ? 0
          : Math.min(filtered.length - 1, Math.max(0, currentIndex + offset));
      setPage(Math.floor(nextIndex / LIST_PAGE_SIZE) + 1);
      onSelect(filtered[nextIndex].id);
    },
    [filtered, selectedIssueId, onSelect, setPage],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable], [role="combobox"], [role="listbox"], [role="menu"], [role="tablist"], [role="dialog"], [role="alertdialog"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [moveSelection]);

  useEffect(() => {
    if (!selectedIssueId) return;
    const el = listRef.current?.querySelector(`[data-issue-id="${CSS.escape(selectedIssueId)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIssueId]);

  return (
    <div className="flex h-full flex-col gap-3">
      <Tabs value={status} onValueChange={setStatus}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="all">{t('issueFilter.all')}</TabsTrigger>
          <TabsTrigger value="new">{t('comparison.new')}</TabsTrigger>
          <TabsTrigger value="fixed">{t('comparison.fixed')}</TabsTrigger>
          <TabsTrigger value="remaining">{t('comparison.remaining')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid grid-cols-1 gap-2">
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('issueFilter.severityPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('issueFilter.allSeverities')}</SelectItem>
            {SEVERITY_ORDER.map((item) => (
              <SelectItem key={item} value={item}>
                {t(`severity.${item}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={t('issueFilter.searchPlaceholder')}
            className="pl-9"
          />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">{t('issueFilter.count', { count: filtered.length })}</div>
      {canReview && selection.count >= 2 && (
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
          <span className="font-medium">{t('issueFilter.batchSelected', { count: selection.count })}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={batchSubmitting}
            onClick={() => setBatchDialog({ status: 'confirmed' })}
          >
            <ShieldCheck className="size-3" />
            {t('issueFilter.batchConfirm')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={batchSubmitting}
            onClick={() => setBatchDialog({ status: 'false_positive' })}
          >
            <XCircle className="size-3" />
            {t('issueFilter.batchFalsePositive')}
          </Button>
          <button
            type="button"
            onClick={selection.clear}
            className="ml-auto text-xs text-muted-foreground hover:underline"
          >
            {t('issueFilter.batchClearSelection')}
          </button>
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {issues.length === 0 ? (
              t('issueFilter.emptyScan')
            ) : (
              <>
                <p>{t('issueFilter.emptyFiltered')}</p>
                {hasActiveFilter && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-2 text-xs font-medium text-primary hover:underline"
                  >
                    {t('issueFilter.clearFilters')}
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          paged.map((issue) => (
            <div key={issue.id} className="flex items-start gap-1.5">
              {canReview && (
                <div className="flex h-full items-center pt-3.5">
                  <Checkbox
                    checked={selection.selected.has(issue.id)}
                    onCheckedChange={() => selection.toggle(issue.id)}
                    aria-label={t('issueFilter.batchSelectAria', { id: issue.id })}
                  />
                </div>
              )}
              <button
                data-issue-id={issue.id}
                type="button"
                onClick={() => onSelect(issue.id)}
                className={cn(
                  'min-w-0 flex-1 rounded-lg border p-3 text-left transition-colors',
                  selectedIssueId === issue.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      'shrink-0 text-xs font-normal',
                      SEVERITY_BADGE_CLASS[issue.severity],
                      'border-transparent',
                    )}
                  >
                    {t(`severity.${issue.severity}`)}
                  </Badge>
                  <Badge
                    className={cn(
                      'shrink-0 text-xs font-normal',
                      COMPARISON_VISUALS[issue.comparisonStatus].badge,
                    )}
                  >
                    {t(`comparison.${issue.comparisonStatus}`)}
                  </Badge>
                  {issue.rulepackName && (
                    <Badge
                      variant="outline"
                      className="min-w-0 shrink-0 px-1.5 text-xs font-normal text-muted-foreground"
                    >
                      {packDisplayName(issue.rulepackName, issue.rulepackId)}
                    </Badge>
                  )}
                  {issue.review && (
                    <Badge
                      className={cn(
                        'shrink-0 text-xs font-normal',
                        REVIEW_BADGE_CLASS[issue.review.status],
                      )}
                      title={issue.review.reason}
                    >
                      {t(`reviewStatus.${issue.review.status}`)}
                    </Badge>
                  )}
                  {onOpenKnowledge ? (
                    <KnowledgeLink issue={issue} onOpen={onOpenKnowledge} />
                  ) : (
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      {issue.ruleId}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm font-medium">
                  {lookupRuleMessage(messageMap, issue.ruleId, issue.message) || t('issues.noDescription')}
                </p>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {issue.filePath || t('issues.unknownPath')}:{issue.startLine}
                </p>
              </button>
            </div>
          ))
        )}
      </div>
      <Pagination
        page={safePage}
        pageCount={pageCount}
        onPage={setPage}
        className="shrink-0 border-t pt-2"
      />

      <AlertDialog open={!!batchDialog} onOpenChange={(open) => { if (!open) { setBatchDialog(null); setBatchReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {batchDialog?.status === 'confirmed'
                ? t('issueFilter.batchConfirmTitle')
                : t('issueFilter.batchFalsePositiveTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('issueFilter.batchDialogDesc', { count: selection.count })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="batch-review-reason">
                {batchDialog?.status === 'false_positive'
                  ? t('issueFilter.batchReasonRequired')
                  : t('issueFilter.batchReasonOptional')}
              </Label>
              <Textarea
                id="batch-review-reason"
                value={batchReason}
                onChange={(event) => setBatchReason(event.target.value)}
                placeholder={t('issueFilter.batchReasonPlaceholder')}
                rows={2}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleBatchReview(); }}
              disabled={batchSubmitting || (batchDialog?.status === 'false_positive' && !batchReason.trim())}
            >
              {batchSubmitting ? t('issueFilter.batchSubmitting') : t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
