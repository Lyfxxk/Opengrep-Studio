import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import type { IIssue } from '@/data/issues';
import { COMPARISON_VISUALS } from '@/data/constants';

interface ComparisonSummaryProps {
  issues: IIssue[];
  baselineScanId: string;
}

export default function ComparisonSummary({
  issues,
  baselineScanId,
}: ComparisonSummaryProps) {
  const { t } = useTranslation();
  const stats = useMemo(
    () => ({
      newCount: issues.filter((issue) => issue.comparisonStatus === 'new').length,
      fixedCount: issues.filter((issue) => issue.comparisonStatus === 'fixed').length,
      remainingCount: issues.filter(
        (issue) => issue.comparisonStatus === 'remaining',
      ).length,
    }),
    [issues],
  );

  const items = [
    { key: 'summaryNew', value: stats.newCount, ...COMPARISON_VISUALS.new },
    { key: 'summaryFixed', value: stats.fixedCount, ...COMPARISON_VISUALS.fixed },
    { key: 'summaryRemaining', value: stats.remainingCount, ...COMPARISON_VISUALS.remaining },
  ] as const;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.key}>
            <CardContent className="flex items-center gap-4 p-5">
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-full ${item.bg}`}
              >
                <Icon className={`size-5 ${item.tone}`} />
              </div>
              <div className="min-w-0">
                <div className={`text-2xl font-bold tabular-nums ${item.tone}`}>
                  {item.value}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t(`comparison.${item.key}`)} · {t('comparison.vsBaseline', { id: baselineScanId })}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
