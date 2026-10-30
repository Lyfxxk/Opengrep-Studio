import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, FileCode2, Loader2, MousePointerClick, ShieldCheck, WrapText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import type { IIssue } from '@/data/issues';
import { REVIEW_BADGE_CLASS } from '@/data/issues';
import type { ICodeSnippet } from '@/data/codesnippets';
import { api } from '@/lib/api';
import { usePackDisplayName } from '@/lib/packName';
import { lookupRuleMessage, useRuleMessageMap } from '@/lib/ruleMessages';
import { SEVERITY_BADGE_CLASS } from '@/lib/severity';
import { cn } from '@/lib/utils';
import TaintFlow from './TaintFlow';

interface CodeSnippetViewerProps {
  scanId: string;
  issue: IIssue | null;
  onOpenReview?: (issue: IIssue) => void;
  onOpenKnowledge?: (ruleId: string) => void;
}

export default function CodeSnippetViewer({
  scanId,
  issue,
  onOpenReview,
  onOpenKnowledge,
}: CodeSnippetViewerProps) {
  const { t } = useTranslation();
  const packDisplayName = usePackDisplayName();
  const [snippet, setSnippet] = useState<ICodeSnippet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [wrap, setWrap] = useState(false);
  const messageMap = useRuleMessageMap();

  useEffect(() => {
    if (!issue) {
      setSnippet(null);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .getSnippet(scanId, issue)
      .then((data) => {
        if (!cancelled) setSnippet(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSnippet(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scanId, issue]);

  if (!issue) {
    return (
      <Card className="flex h-full min-h-[320px] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
          <MousePointerClick className="size-8" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FileCode2 className="size-4 shrink-0 text-primary" />
          <span className="truncate font-mono text-sm font-medium">{issue.filePath}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            L{issue.startLine}–L{issue.endLine}
          </span>
          <Badge
            className={cn(
              'shrink-0 text-xs font-normal',
              SEVERITY_BADGE_CLASS[issue.severity],
            )}
          >
            {t(`severity.${issue.severity}`)}
          </Badge>
          {issue.review && (
            <Badge className={cn('shrink-0 text-xs font-normal', REVIEW_BADGE_CLASS[issue.review.status])}>
              {t(`reviewStatus.${issue.review.status}`)}
              {issue.review.reviewer ? ` · ${issue.review.reviewer}` : ''}
            </Badge>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 gap-1 px-2 text-xs', wrap && 'text-primary')}
              onClick={() => setWrap((prev) => !prev)}
              title={t(wrap ? 'snippet.wrapOff' : 'snippet.wrapOn')}
            >
              <WrapText className="size-3.5" />
            </Button>
            {onOpenKnowledge && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onOpenKnowledge(issue.ruleId)}
              >
                <BookOpen className="size-3.5" />
                {t('snippet.knowledgeBtn')}
              </Button>
            )}
            {onOpenReview && issue.fingerprint && (
              <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => onOpenReview(issue)}>
                <ShieldCheck className="size-3.5" />
                {issue.review ? t('snippet.reReview') : t('snippet.review')}
              </Button>
            )}
          </span>
        </div>
        <CardDescription className="text-xs">
          <span className="font-mono">{issue.ruleId}</span>
          {issue.rulepackName && (
            <span className="text-foreground/60">
              {' · '}
              {packDisplayName(issue.rulepackName, issue.rulepackId)}
            </span>
          )}
          {' · '}
          {lookupRuleMessage(messageMap, issue.ruleId, issue.message)}
        </CardDescription>
        {issue.review?.reason && (
          <CardDescription className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs leading-5">
            {t('snippet.reviewConclusion', { status: t(`reviewStatus.${issue.review.status}`) })}
            {issue.review.reviewer ? t('snippet.reviewerSuffix', { reviewer: issue.review.reviewer }) : ''}
            {' — '}
            {issue.review.reason}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        {issue.taintFlow && issue.taintFlow.length > 0 && (
          <div className="shrink-0 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground">
              {t('snippet.taintFlowTitle')}
            </h4>
            <TaintFlow steps={issue.taintFlow} />
          </div>
        )}
        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('snippet.snippetLoading')}
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('snippet.snippetFailed', { error })}
          </div>
        ) : snippet ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/40">
            <pre className="m-0 font-mono text-xs leading-6">
              {snippet.content.split('\n').map((line, index) => {
                const lineNo = snippet.startLine + index;
                const highlighted = snippet.highlightedLines.includes(lineNo);
                return (
                  <div
                    key={lineNo}
                    className={cn('flex', highlighted && 'bg-destructive/10')}
                  >
                    <span
                      className={cn(
                        'w-12 shrink-0 select-none border-r border-border/60 px-2 text-right tabular-nums',
                        highlighted ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {lineNo}
                    </span>
                    <code
                      className={cn(
                        'min-w-0 px-3',
                        wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
                        highlighted && 'font-medium text-foreground',
                      )}
                    >
                      {line || ' '}
                    </code>
                  </div>
                );
              })}
            </pre>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            {t('snippet.noSnippet')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
