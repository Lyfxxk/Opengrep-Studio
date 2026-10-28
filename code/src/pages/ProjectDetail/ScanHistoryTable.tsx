import { useTranslation } from 'react-i18next';
import { Eye, Flag, FlagOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import ScanStatusBadge from '@/components/ScanStatusBadge';
import RulePackCell from '@/components/RulePackCell';
import type { IScanResult } from '@/data/scanresults';
import { formatDateTime } from '@/lib/format';

interface ScanHistoryTableProps {
  scans: IScanResult[];
  baselineScanId?: string;
  onSetBaseline: (scanId: string) => void;
  onUnsetBaseline: () => void;
  onView: (scanId: string) => void;
}

export default function ScanHistoryTable({
  scans,
  baselineScanId,
  onSetBaseline,
  onUnsetBaseline,
  onView,
}: ScanHistoryTableProps) {
  const { t } = useTranslation();
  if (scans.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        {t('projectDetail.historyEmpty')}
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">{t('scans.colScanId')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('scans.colStatus')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('scans.colIssues')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('scans.colRulePacks')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('projectDetail.colBaseline')}</TableHead>
            <TableHead className="whitespace-nowrap">{t('scans.colTime')}</TableHead>
            <TableHead className="whitespace-nowrap text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scans.map((scan) => {
            const isBaseline = scan.id === baselineScanId;
            // 失败扫描也开放查看：结果页的失败卡片是失败原因唯一展示点，不放行就零入口
            const viewable = scan.status === 'completed' || scan.status === 'failed';
            return (
              <TableRow
                key={scan.id}
                className={viewable ? 'cursor-pointer' : ''}
                onClick={() => {
                  if (viewable) {
                    onView(scan.id);
                  }
                }}
              >
                <TableCell className="font-mono text-xs">{scan.id}</TableCell>
                <TableCell>
                  <ScanStatusBadge status={scan.status} />
                </TableCell>
                <TableCell className="tabular-nums">
                  {scan.status === 'completed' ? scan.issueCount : '—'}
                </TableCell>
                <TableCell className="max-w-[220px]">
                  <RulePackCell scan={scan} className="max-w-[220px]" />
                </TableCell>
                <TableCell>
                  {isBaseline ? (
                    <Badge className="gap-1 font-normal">
                      <Flag className="size-3" />
                      {t('projectDetail.baselineTag')}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatDateTime(scan.scannedAt)}
                </TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1"
                      disabled={!viewable}
                      onClick={() => onView(scan.id)}
                    >
                      <Eye className="size-3.5" />
                      {t('projectDetail.actionView')}
                    </Button>
                    {isBaseline ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-muted-foreground"
                        title={t('projectDetail.unsetBaselineTitle')}
                        onClick={onUnsetBaseline}
                      >
                        <FlagOff className="size-3.5" />
                        {t('projectDetail.unsetBaseline')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        disabled={scan.status !== 'completed'}
                        onClick={() => onSetBaseline(scan.id)}
                      >
                        <Flag className="size-3.5" />
                        {t('projectDetail.setBaseline')}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
