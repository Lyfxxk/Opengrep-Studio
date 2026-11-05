import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, FileText, GitCompareArrows } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import Pagination from '@/components/Pagination';
import ListFilterBar from '@/components/ListFilterBar';
import { LIST_PAGE_SIZE } from '@/data/constants';
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
import BatchDeleteBar, { BatchDeleteConfirm } from '@/components/BatchDeleteBar';
import CompareDialog from '@/pages/ScanResult/CompareDialog';
import {
  filterScans,
  usePagedList,
  useRowSelection,
  useScanRows,
  type ScanWithProject,
} from '@/lib/usePagedList';
import { formatDateTime } from '@/lib/format';
import { api } from '@/lib/api';
import { hasRole } from '@/lib/auth';

export default function ScansCenterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canDelete = hasRole('admin');
  const { scans, projects, loadFailed, reload: load } = useScanRows();
  const [filterProjectId, setFilterProjectId] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [compareScanId, setCompareScanId] = useState<string | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const hasScanning = useMemo(() => (scans ?? []).some((scan) => scan.status === 'scanning'), [scans]);

  const filteredScans = useMemo(
    () => filterScans(scans ?? [], filterProjectId, keyword),
    [scans, filterProjectId, keyword],
  );

  const deletableIds = useMemo(
    () => filteredScans.filter((scan) => scan.status !== 'scanning').map((scan) => scan.id),
    [filteredScans],
  );
  const selection = useRowSelection(deletableIds);

  const { page: safePage, setPage, pageCount, slice: pagedScans } = usePagedList(filteredScans, LIST_PAGE_SIZE);

  useEffect(() => {
    if (!hasScanning) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [hasScanning, load]);

  const viewScan = (scan: ScanWithProject) => navigate(`/projects/${scan.projectId}/scans/${scan.id}`);

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
    if (failed > 0) toast.warning(t('scans.batchPartial', { count: ids.length - failed, failed }));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('nav.scans')}</h1>
      </div>

      {canDelete && (
        <BatchDeleteBar
          count={selection.count}
          entity="scan"
          deleting={batchDeleting}
          onDelete={() => setBatchConfirmOpen(true)}
          onClear={selection.clear}
        />
      )}

      <ListFilterBar
        total={scans?.length ?? 0}
        projects={projects}
        projectId={filterProjectId}
        onProjectChange={setFilterProjectId}
        keyword={keyword}
        onKeywordChange={setKeyword}
        allLabel={t('scans.filterProjectAll')}
        placeholder={t('scans.filterKeywordPlaceholder')}
        countLabel={t('scans.filterCount', { count: filteredScans.length })}
      />

      {loadFailed && scans !== null && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-muted-foreground">
          {t('common.loadFailedHint')}
          <button
            type="button"
            className="ml-2 font-medium text-primary hover:underline"
            onClick={() => void load()}
          >
            {t('common.retry')}
          </button>
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
                {canDelete && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selection.allSelected ? true : selection.someSelected ? 'indeterminate' : false}
                      onCheckedChange={() => selection.toggleAll()}
                      aria-label={t('scans.selectAllAria')}
                    />
                  </TableHead>
                )}
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
                const viewable = done || scan.status === 'failed';
                return (
                  <TableRow
                    key={scan.id}
                    className={viewable ? 'cursor-pointer' : ''}
                    onClick={() => {
                      if (viewable) viewScan(scan);
                    }}
                  >
                    {canDelete && (
                      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selection.selected.has(scan.id)}
                          onCheckedChange={() => selection.toggle(scan.id)}
                          disabled={scan.status === 'scanning'}
                          aria-label={t('scans.rowSelectAria', { id: scan.id })}
                        />
                      </TableCell>
                    )}
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

      <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />

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
