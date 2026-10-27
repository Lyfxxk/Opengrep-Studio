import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import { KnowledgeLink } from './KnowledgeSheet';

interface IssueFilterListProps {
  issues: IIssue[];
  selectedIssueId: string | null;
  onSelect: (issueId: string) => void;
  onOpenKnowledge?: (ruleId: string) => void;
}

export default function IssueFilterList({
  issues,
  selectedIssueId,
  onSelect,
  onOpenKnowledge,
}: IssueFilterListProps) {
  const { t } = useTranslation();
  const [severity, setSeverity] = useState('all');
  const [status, setStatus] = useState('all');
  const [keyword, setKeyword] = useState('');
  const messageMap = useRuleMessageMap();

  const filtered = useMemo(
    () =>
      issues.filter((issue) => {
        if (severity !== 'all' && issue.severity !== severity) return false;
        if (status !== 'all' && issue.comparisonStatus !== status) return false;
        const keywordTrimmed = keyword.trim().toLowerCase();
        if (keywordTrimmed === '') return true;
        const translated = lookupRuleMessage(messageMap, issue.ruleId, '');
        return (
          issue.filePath.toLowerCase().includes(keywordTrimmed) ||
          issue.message.toLowerCase().includes(keywordTrimmed) ||
          translated.toLowerCase().includes(keywordTrimmed)
        );
      }),
    [issues, severity, status, keyword, messageMap],
  );

  // 有问题但被筛选条件滤空 ≠ 扫描本身没发现问题，两种空态要分开表述
  const hasActiveFilter =
    severity !== 'all' || status !== 'all' || keyword.trim() !== '';
  const resetFilters = () => {
    setSeverity('all');
    setStatus('all');
    setKeyword('');
  };

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
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
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
          filtered.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => onSelect(issue.id)}
              className={cn(
                'w-full rounded-lg border p-3 text-left transition-colors',
                selectedIssueId === issue.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50',
              )}
            >
              {/* flex-wrap：窄栏（如 1024 断点三列布局）下徽章放不下时换行，避免把列表撑出横向滚动 */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge
                  className={cn(
                    'shrink-0 text-xs font-normal',
                    SEVERITY_BADGE_CLASS[issue.severity],
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
                    className="max-w-[110px] shrink-0 truncate px-1.5 text-xs font-normal text-muted-foreground"
                    title={t('issueFilter.packSourceTitle', { name: issue.rulepackName })}
                  >
                    {issue.rulepackName}
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
              <p className="mt-2 line-clamp-2 text-sm font-medium">
                {lookupRuleMessage(messageMap, issue.ruleId, issue.message)}
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {issue.filePath}:{issue.startLine}
              </p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
