import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, FileText, GitCompareArrows, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import BatchDeleteBar from '@/components/BatchDeleteBar';
import BatchDeleteConfirm from '@/components/BatchDeleteConfirm';
import CompareDialog from '@/pages/ScanResult/CompareDialog';
import { useRowSelection } from '@/lib/useRowSelection';
import { attachProjectNames, type ScanWithProject } from '@/lib/scans';
import { formatDateTime } from '@/lib/format';
import { api } from '@/lib/api';

/** 扫描中心：全部项目的扫描总览，双快照对比的固定入口 */
export default function ScansCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [scans, setScans] = useState<ScanWithProject[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [compareScanId, setCompareScanId] = useState<string | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  // 进行中的扫描还在被引擎写入，禁止勾选删除；全选范围也只覆盖可删除的行
  const deletableIds = useMemo(
    () => (scans ?? []).filter((scan) => scan.status !== 'scanning').map((scan) => scan.id),
    [scans],
  );
  const selection = useRowSelection(deletableIds);

  const load = useCallback(async () => {
    try {
      const [allScans, projects] = await Promise.all([api.listAllScans(), api.listProjects()]);
      setScans(attachProjectNames(allScans, projects));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setScans([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasScanning = useMemo(() => (scans ?? []).some((scan) => scan.status === 'scanning'), [scans]);

  // 有扫描进行中时轮询刷新，全部落定后停止
  useEffect(() => {
    if (!hasScanning) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [hasScanning, load]);

  const viewScan = (scan: ScanWithProject) => navigate(`/projects/${scan.projectId}/scans/${scan.id}`);

  // 逐个调用单删接口：某一项失败（如刚好进入扫描中）不影响其余项，最后汇总报数
  const handleBatchDelete = async () => {
    const ids = [...selection.selected];
    setBatchConfirmOpen(false);
    setBatchDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteScan(id);
      } catch {
        failed += 1;
      }
    }
    setBatchDeleting(false);
    selection.clear();
    await load();
    if (failed === 0) toast.success(t('scans.batchDeleted', { count: ids.length }));
    else toast.warning(t('scans.batchPartial', { count: ids.length - failed, failed }));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('nav.scans')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('scans.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        >
          <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {t('scans.refresh')}
        </Button>
      </div>

      <BatchDeleteBar
        count={selection.count}
        entity="scan"
        deleting={batchDeleting}
        onDelete={() => setBatchConfirmOpen(true)}
        onClear={selection.clear}
      />

      {scans === null ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : scans.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('scans.emptyPrefix')}
          <Link to="/projects" className="mx-1 text-primary hover:underline">
            {t('nav.projects')}
          </Link>
          {t('scans.emptySuffix')}
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selection.allSelected ? true : selection.someSelected ? 'indeterminate' : false}
                    onCheckedChange={() => selection.toggleAll()}
                    aria-label={t('scans.selectAllAria')}
                  />
                </TableHead>
                <TableHead className="whitespace-nowrap">{t('scans.colProject')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('scans.colScanId')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('scans.colStatus')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('scans.colIssues')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('scans.colRulePacks')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('scans.colTime')}</TableHead>
                <TableHead className="whitespace-nowrap text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scans.map((scan) => {
                const done = scan.status === 'completed';
                return (
                  <TableRow
                    key={scan.id}
                    className={done ? 'cursor-pointer' : ''}
                    onClick={() => {
                      if (done) viewScan(scan);
                    }}
                  >
                    <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.selected.has(scan.id)}
                        onCheckedChange={() => selection.toggle(scan.id)}
                        disabled={scan.status === 'scanning'}
                        aria-label={t('scans.rowSelectAria', { id: scan.id })}
                      />
                    </TableCell>
                    <TableCell className="max-w-[180px]">
                      <span className="block truncate" title={scan.projectName}>
                        {scan.projectName}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{scan.id}</TableCell>
                    <TableCell>
                      <ScanStatusBadge status={scan.status} />
                    </TableCell>
                    <TableCell className="tabular-nums">{done ? scan.issueCount : '—'}</TableCell>
                    <TableCell className="max-w-[200px]">
                      <RulePackCell scan={scan} />
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
                          disabled={!done}
                          onClick={() => viewScan(scan)}
                        >
                          <Eye className="size-3.5" />
                          {t('scans.actionResult')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          disabled={!done}
                          title={t('scans.actionReportTitle')}
                          onClick={() =>
                            navigate(`/projects/${scan.projectId}/scans/${scan.id}/report`)
                          }
                        >
                          <FileText className="size-3.5" />
                          {t('scans.actionReport')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          disabled={!done}
                          title={t('scans.actionCompareTitle')}
                          onClick={() => setCompareScanId(scan.id)}
                        >
                          <GitCompareArrows className="size-3.5" />
                          {t('scans.actionCompare')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {compareScanId && (
        <CompareDialog scanId={compareScanId} onClose={() => setCompareScanId(null)} />
      )}

      <BatchDeleteConfirm
        open={batchConfirmOpen}
        entity="scan"
        count={selection.count}
        extra={t('scans.batchExtra')}
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
