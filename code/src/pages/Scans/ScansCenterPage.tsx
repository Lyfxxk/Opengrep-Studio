import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, FileText, GitCompareArrows, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import Pagination from '@/components/Pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { usePagedList } from '@/lib/usePagedList';
import { attachProjectNames, type ScanWithProject } from '@/lib/scans';
import { formatDateTime } from '@/lib/format';
import type { IProject } from '@/data/projects';
import { api } from '@/lib/api';

/** 扫描中心：全部项目的扫描总览，双快照对比的固定入口 */
export default function ScansCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [scans, setScans] = useState<ScanWithProject[] | null>(null);
  /** 加载失败与"确实一条都没有"必须区分：失败时给可操作的重试入口，而不是假的空态 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [projects, setProjects] = useState<IProject[]>([]);
  const [filterProjectId, setFilterProjectId] = useState('all');
  const [keyword, setKeyword] = useState('');
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
      setProjects(projects);
      setScans(attachProjectNames(allScans, projects));
      setLoadFailed(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasScanning = useMemo(() => (scans ?? []).some((scan) => scan.status === 'scanning'), [scans]);

  /** 筛选：项目下拉 + 关键字（匹配扫描编号 / 项目名） */
  const filteredScans = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    return (scans ?? []).filter((scan) => {
      if (filterProjectId !== 'all' && scan.projectId !== filterProjectId) return false;
      if (trimmed === '') return true;
      return (
        scan.id.toLowerCase().includes(trimmed) ||
        (scan.projectName ?? '').toLowerCase().includes(trimmed)
      );
    });
  }, [scans, filterProjectId, keyword]);

  // 分页：扫描进行中的轮询会频繁重刷列表，页码夹取保证删行 / 新增后不落在空页上
  const pageSize = 20;
  const { page: safePage, setPage, pageCount, slice: pagedScans } = usePagedList(filteredScans, pageSize);

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
      </div>

      <BatchDeleteBar
        count={selection.count}
        entity="scan"
        deleting={batchDeleting}
        onDelete={() => setBatchConfirmOpen(true)}
        onClear={selection.clear}
      />

      {(scans?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filterProjectId} onValueChange={setFilterProjectId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder={t('scans.filterProjectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('scans.filterProjectAll')}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative min-w-[180px] flex-1 sm:max-w-[280px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t('scans.filterKeywordPlaceholder')}
              className="pl-9"
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {t('scans.filterCount', { count: filteredScans.length })}
          </span>
        </div>
      )}

      {scans === null ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {loadFailed ? (
            <>
              {t('common.loadFailedHint')}
              <button
                type="button"
                className="ml-2 text-sm font-medium text-primary hover:underline"
                onClick={() => void load()}
              >
                {t('common.retry')}
              </button>
            </>
          ) : (
            t('common.loading')
          )}
        </div>
      ) : filteredScans.length === 0 && scans.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('scans.emptyPrefix')}
          <Link to="/projects" className="mx-1 text-primary hover:underline">
            {t('nav.projects')}
          </Link>
          {t('scans.emptySuffix')}
        </div>
      ) : (
        filteredScans.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            {t('scans.filterEmpty')}
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
              {pagedScans.map((scan) => {
                const done = scan.status === 'completed';
                // 失败扫描也开放查看：结果页的失败卡片是失败原因唯一展示点，不放行就零入口
                const viewable = done || scan.status === 'failed';
                return (
                  <TableRow
                    key={scan.id}
                    className={viewable ? 'cursor-pointer' : ''}
                    onClick={() => {
                      if (viewable) viewScan(scan);
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
                      <ScanStatusBadge status={scan.status} queued={Boolean(scan.queuedAt)} />
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
                          disabled={!viewable}
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
        )
      )}

      {filteredScans.length > pageSize && (
        <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
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
