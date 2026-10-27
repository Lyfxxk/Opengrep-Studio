import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
    if (failed === 0) toast.success(`已删除 ${ids.length} 条扫描`);
    else toast.warning(`已删除 ${ids.length - failed} 条扫描，${failed} 条失败（可能刚进入扫描中）`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">扫描中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            全部项目的扫描总览：直达结果与报告，任选两次已完成扫描做双快照对比（可跨项目）
          </p>
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
          刷新
        </Button>
      </div>

      <BatchDeleteBar
        count={selection.count}
        label="扫描"
        deleting={batchDeleting}
        onDelete={() => setBatchConfirmOpen(true)}
        onClear={selection.clear}
      />

      {scans === null ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : scans.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          暂无扫描记录，到
          <Link to="/projects" className="mx-1 text-primary hover:underline">
            项目管理
          </Link>
          新建项目并上传源码后发起首次扫描
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
                    aria-label="全选扫描"
                  />
                </TableHead>
                <TableHead className="whitespace-nowrap">项目</TableHead>
                <TableHead className="whitespace-nowrap">扫描编号</TableHead>
                <TableHead className="whitespace-nowrap">状态</TableHead>
                <TableHead className="whitespace-nowrap">问题数</TableHead>
                <TableHead className="whitespace-nowrap">规则包</TableHead>
                <TableHead className="whitespace-nowrap">扫描时间</TableHead>
                <TableHead className="whitespace-nowrap text-right">操作</TableHead>
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
                        aria-label={`选择扫描 ${scan.id}`}
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
                          结果
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          disabled={!done}
                          title="在线测试报告"
                          onClick={() =>
                            navigate(`/projects/${scan.projectId}/scans/${scan.id}/report`)
                          }
                        >
                          <FileText className="size-3.5" />
                          报告
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          disabled={!done}
                          title="与其他已完成扫描做双快照对比"
                          onClick={() => setCompareScanId(scan.id)}
                        >
                          <GitCompareArrows className="size-3.5" />
                          对比
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
        label="扫描"
        count={selection.count}
        extra="扫描的问题明细与源码快照将一并移除；其他扫描指向它的基线对比会自动解除。"
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
