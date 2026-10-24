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
  if (scans.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        暂无扫描记录，上传源码后点击「开始扫描」
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">扫描编号</TableHead>
            <TableHead className="whitespace-nowrap">状态</TableHead>
            <TableHead className="whitespace-nowrap">问题数</TableHead>
            <TableHead className="whitespace-nowrap">规则包</TableHead>
            <TableHead className="whitespace-nowrap">基线</TableHead>
            <TableHead className="whitespace-nowrap">扫描时间</TableHead>
            <TableHead className="whitespace-nowrap text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scans.map((scan) => {
            const isBaseline = scan.id === baselineScanId;
            return (
              <TableRow
                key={scan.id}
                className={scan.status === 'completed' ? 'cursor-pointer' : ''}
                onClick={() => {
                  if (scan.status === 'completed') {
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
                      基线
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
                      disabled={scan.status !== 'completed'}
                      onClick={() => onView(scan.id)}
                    >
                      <Eye className="size-3.5" />
                      查看
                    </Button>
                    {isBaseline ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-muted-foreground"
                        title="取消后，后续扫描不再自动与基线对比"
                        onClick={onUnsetBaseline}
                      >
                        <FlagOff className="size-3.5" />
                        取消基线
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
                        设为基线
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
