import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileCode2, FileText, ListOrdered, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Pagination from '@/components/Pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LIST_PAGE_SIZE } from '@/data/constants';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import RulePackCell from '@/components/RulePackCell';
import { attachProjectNames, type ScanWithProject } from '@/lib/scans';
import { usePagedList } from '@/lib/usePagedList';
import { formatDateTime } from '@/lib/format';
import type { IProject } from '@/data/projects';
import { api } from '@/lib/api';

/** 报告中心：全部已完成扫描的测试报告总览（在线报告 / 自包含 HTML / 可复现清单） */
export default function ReportsCenterPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ScanWithProject[] | null>(null);
  /** 加载失败与"确实一份报告都没有"必须区分：失败时给可操作的重试入口，而不是假的空态 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [projects, setProjects] = useState<IProject[]>([]);
  const [filterProjectId, setFilterProjectId] = useState('all');
  const [keyword, setKeyword] = useState('');

  const load = useCallback(async () => {
    try {
      const [allScans, projects] = await Promise.all([api.listAllScans(), api.listProjects()]);
      setProjects(projects);
      setLoadFailed(false);
      setRows(
        attachProjectNames(
          allScans.filter((scan) => scan.status === 'completed'),
          projects,
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 筛选：项目下拉 + 关键字（匹配扫描编号 / 项目名） */
  const filteredRows = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    return (rows ?? []).filter((scan) => {
      if (filterProjectId !== 'all' && scan.projectId !== filterProjectId) return false;
      if (trimmed === '') return true;
      return (
        scan.id.toLowerCase().includes(trimmed) ||
        (scan.projectName ?? '').toLowerCase().includes(trimmed)
      );
    });
  }, [rows, filterProjectId, keyword]);

  // 页码夹取：删除 / 新增行后不落在空页上
  const { page: safePage, setPage, pageCount, slice: pagedRows } = usePagedList(filteredRows, LIST_PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('nav.reports')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('reports.subtitle')}</p>
        </div>
      </div>

      {(rows?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filterProjectId} onValueChange={setFilterProjectId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder={t('reports.filterProjectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('reports.filterProjectAll')}</SelectItem>
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
              placeholder={t('reports.filterKeywordPlaceholder')}
              className="pl-9"
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {t('reports.filterCount', { count: filteredRows.length })}
          </span>
        </div>
      )}

      {rows === null ? (
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
      ) : filteredRows.length === 0 && rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('reports.emptyPrefix')}
          <Link to="/scans" className="mx-1 text-primary hover:underline">
            {t('nav.scans')}
          </Link>
          {t('reports.emptySuffix')}
        </div>
      ) : (
        filteredRows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            {t('reports.filterEmpty')}
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t('reports.colProject')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('reports.colScanId')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('reports.colIssues')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('reports.colRulePacks')}</TableHead>
                <TableHead className="whitespace-nowrap">{t('reports.colTime')}</TableHead>
                <TableHead className="whitespace-nowrap text-right">{t('reports.colDeliverables')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedRows.map((scan) => (
                <TableRow key={scan.id}>
                  <TableCell className="max-w-[180px]">
                    <span className="block truncate" title={scan.projectName}>
                      {scan.projectName}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{scan.id}</TableCell>
                  <TableCell className="tabular-nums">{scan.issueCount}</TableCell>
                  <TableCell className="max-w-[200px]">
                    <RulePackCell scan={scan} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {formatDateTime(scan.scannedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" className="gap-1" asChild>
                        <Link to={`/projects/${scan.projectId}/scans/${scan.id}/report`}>
                          <FileText className="size-3.5" />
                          {t('reports.actionOnline')}
                        </Link>
                      </Button>
                      {!api.isMockMode && (
                        <>
                          <Button variant="ghost" size="sm" className="gap-1" asChild>
                            <a
                              href={api.scanReportHtmlUrl(scan.id)}
                              download
                              title={t('reports.actionHtmlTitle')}
                            >
                              <FileCode2 className="size-3.5" />
                              {t('reports.actionHtml')}
                            </a>
                          </Button>
                          <Button variant="outline" size="sm" className="gap-1" asChild>
                            <a
                              href={api.scanManifestUrl(scan.id)}
                              download
                              title={t('reports.actionManifestTitle')}
                            >
                              <ListOrdered className="size-3.5" />
                              {t('reports.actionManifest')}
                            </a>
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        )
      )}

      {filteredRows.length > LIST_PAGE_SIZE && (
        <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
      )}
    </div>
  );
}
