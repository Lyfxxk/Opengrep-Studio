import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileCode2, FileText, ListOrdered } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import Pagination from '@/components/Pagination';
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
import { formatDateTime } from '@/lib/format';
import { api } from '@/lib/api';

/** 报告中心：全部已完成扫描的测试报告总览（在线报告 / 自包含 HTML / 可复现清单） */
export default function ReportsCenterPage() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ScanWithProject[] | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try {
      const [allScans, projects] = await Promise.all([api.listAllScans(), api.listProjects()]);
      setRows(
        attachProjectNames(
          allScans.filter((scan) => scan.status === 'completed'),
          projects,
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 页码夹取：删除 / 新增行后不落在空页上
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil((rows?.length ?? 0) / pageSize));
  const safePage = Math.min(page, pageCount);
  useEffect(() => {
    setPage(safePage);
  }, [safePage]);
  const pagedRows = (rows ?? []).slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('nav.reports')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('reports.subtitle')}</p>
        </div>
      </div>

      {rows === null ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t('reports.emptyPrefix')}
          <Link to="/scans" className="mx-1 text-primary hover:underline">
            {t('nav.scans')}
          </Link>
          {t('reports.emptySuffix')}
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
                              manifest
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
      )}

      {(rows?.length ?? 0) > pageSize && (
        <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
      )}
    </div>
  );
}
