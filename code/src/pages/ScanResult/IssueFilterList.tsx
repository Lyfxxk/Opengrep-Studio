import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
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
import { usePackDisplayName } from '@/lib/packName';
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
  const packDisplayName = usePackDisplayName();

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

  // 有问题但被筛选条件滤空 ≠ 扫描本身没发现问题，两种空态要分开表述
  const hasActiveFilter =
    severity !== 'all' || status !== 'all' || keyword.trim() !== '';
  const resetFilters = () => {
    setSeverity('all');
    setStatus('all');
    setKeyword('');
  };

  // 筛选或数据变化后页码可能越界（如筛选后只剩一页），渲染前夹回有效范围
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  useEffect(() => {
    setPage(safePage);
  }, [safePage]);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  /** ↑/↓ 在筛选后列表中逐条移动选中项；输入框内不劫持方向键 */
  const listRef = useRef<HTMLDivElement>(null);
  const moveSelection = useCallback(
    (offset: 1 | -1) => {
      if (filtered.length === 0) return;
      const currentIndex = filtered.findIndex((issue) => issue.id === selectedIssueId);
      const nextIndex =
        currentIndex === -1
          ? 0
          : Math.min(filtered.length - 1, Math.max(0, currentIndex + offset));
      onSelect(filtered[nextIndex].id);
    },
    [filtered, selectedIssueId, onSelect],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable]')) return;
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [moveSelection]);

  // 键盘切换后把选中项滚动到可视区域
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
            <button
              key={issue.id}
              data-issue-id={issue.id}
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
                    className="min-w-0 shrink-0 px-1.5 text-xs font-normal text-muted-foreground"
                    title={t('issueFilter.packSourceTitle', { name: issue.rulepackName })}
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
              {/* 不钳制描述行数：截断会让用户漏读风险说明，整段展示（列表内滚动 + 分页控制高度） */}
              <p className="mt-2 text-sm font-medium">
                {lookupRuleMessage(messageMap, issue.ruleId, issue.message)}
              </p>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {issue.filePath}:{issue.startLine}
              </p>
            </button>
          ))
        )}
      </div>
      <Pagination
        page={safePage}
        pageCount={pageCount}
        onPage={setPage}
        className="shrink-0 border-t pt-2"
      />
    </div>
  );
}
