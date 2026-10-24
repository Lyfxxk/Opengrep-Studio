import { useMemo } from 'react';
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
    { label: '新增问题', value: stats.newCount, ...COMPARISON_VISUALS.new },
    { label: '已修复', value: stats.fixedCount, ...COMPARISON_VISUALS.fixed },
    { label: '遗留问题', value: stats.remainingCount, ...COMPARISON_VISUALS.remaining },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.label}>
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
                  {item.label} · 对比基线 {baselineScanId}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
