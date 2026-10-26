import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileCode2, FileText, ListOrdered, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
  const [rows, setRows] = useState<ScanWithProject[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">报告中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            全部已完成扫描的测试报告：在线查看、下载自包含离线 HTML、导出可复现清单
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

      {rows === null ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          暂无可出报告的扫描，到
          <Link to="/scans" className="mx-1 text-primary hover:underline">
            扫描中心
          </Link>
          完成一次扫描后即可生成测试报告
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">项目</TableHead>
                <TableHead className="whitespace-nowrap">扫描编号</TableHead>
                <TableHead className="whitespace-nowrap">问题数</TableHead>
                <TableHead className="whitespace-nowrap">规则包</TableHead>
                <TableHead className="whitespace-nowrap">扫描时间</TableHead>
                <TableHead className="whitespace-nowrap text-right">报告交付</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((scan) => (
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
                          在线报告
                        </Link>
                      </Button>
                      {!api.isMockMode && (
                        <>
                          <Button variant="ghost" size="sm" className="gap-1" asChild>
                            <a
                              href={api.scanReportHtmlUrl(scan.id)}
                              download
                              title="自包含离线 HTML 报告（可打印 PDF / 归档转发）"
                            >
                              <FileCode2 className="size-3.5" />
                              离线 HTML
                            </a>
                          </Button>
                          <Button variant="outline" size="sm" className="gap-1" asChild>
                            <a
                              href={api.scanManifestUrl(scan.id)}
                              download
                              title="可复现清单：源码 SHA-256 + 引擎命令行 + 规则哈希"
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
    </div>
  );
}
