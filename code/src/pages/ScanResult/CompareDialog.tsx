import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleAlert, CircleDot, FilePlus2, FileMinus2, FilePen, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SEVERITY_LABELS } from '@/data/issues';
import type { IScanDiff, IScanDiffIssueList } from '@/data/diffs';
import type { IScanResult } from '@/data/scanresults';
import { attachProjectNames } from '@/lib/scans';
import { formatDateTime } from '@/lib/format';
import { SEVERITY_BADGE_CLASS } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

interface CompareDialogProps {
  scanId: string;
  onClose: () => void;
}

function IssueDiffTable({ list }: { list: IScanDiffIssueList }) {
  if (list.count === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">无</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">位置</th>
            <th className="px-3 py-2 font-medium">规则</th>
            <th className="px-3 py-2 font-medium">严重度</th>
            <th className="px-3 py-2 font-medium">描述</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((item, index) => (
            <tr key={`${item.filePath}-${item.startLine}-${index}`} className="border-t">
              <td className="break-all px-3 py-1.5 font-mono">
                {item.filePath}:{item.startLine}
              </td>
              <td className="px-3 py-1.5 font-mono">{item.ruleId}</td>
              <td className="px-3 py-1.5">
                <Badge className={cn('px-1.5 font-normal', SEVERITY_BADGE_CLASS[item.severity])}>
                  {SEVERITY_LABELS[item.severity]}
                </Badge>
              </td>
              <td className="max-w-[280px] truncate px-3 py-1.5 text-muted-foreground">{item.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.count > list.items.length && (
        <p className="border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          仅展示前 {list.items.length} 条，共 {list.count} 条。
        </p>
      )}
    </div>
  );
}

const DIFF_SECTIONS: Array<{ key: 'new' | 'fixed' | 'remaining'; label: string; icon: typeof CircleAlert; tone: string }> = [
  { key: 'new', label: '本次新增', icon: CircleAlert, tone: 'text-destructive' },
  { key: 'fixed', label: '对方独有（已修复方向）', icon: CircleDot, tone: 'text-success' },
  { key: 'remaining', label: '两次扫描共有', icon: CircleDot, tone: 'text-warning' },
];

/** 双快照对比对话框：任选两次已完成扫描（含跨项目），问题级 + 文件级差异 */
export default function CompareDialog({ scanId, onClose }: CompareDialogProps) {
  const [candidates, setCandidates] = useState<Array<IScanResult & { projectName?: string }> | null>(null);
  const [againstId, setAgainstId] = useState('');
  const [diff, setDiff] = useState<IScanDiff | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all([api.listAllScans(), api.listProjects()])
      .then(([scans, projects]) => {
        if (!mounted) return;
        setCandidates(
          attachProjectNames(
            scans.filter((scan) => scan.status === 'completed' && scan.id !== scanId),
            projects,
          ),
        );
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
        setCandidates([]);
      });
    return () => {
      mounted = false;
    };
  }, [scanId]);

  const runDiff = useCallback(async () => {
    if (!againstId) return;
    setLoading(true);
    try {
      setDiff(await api.getScanDiff(scanId, againstId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [againstId, scanId]);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>双快照对比</DialogTitle>
          <DialogDescription>
            任选一次已完成扫描与当前扫描对比（可跨项目来源）：问题级按指纹比对，文件级按快照内容比对。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={againstId} onValueChange={setAgainstId}>
            <SelectTrigger className="min-w-[320px] flex-1">
              <SelectValue placeholder="选择要对比的扫描…" />
            </SelectTrigger>
            <SelectContent>
              {(candidates ?? []).map((scan) => (
                <SelectItem key={scan.id} value={scan.id}>
                  {scan.projectName} / {scan.id}（{formatDateTime(scan.scannedAt)}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!againstId || loading} onClick={() => void runDiff()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            开始对比
          </Button>
        </div>

        {diff && (
          <Tabs defaultValue="issues">
            <TabsList>
              <TabsTrigger value="issues">问题差异</TabsTrigger>
              <TabsTrigger value="files">文件差异</TabsTrigger>
            </TabsList>
            <TabsContent value="issues" className="space-y-4 pt-3">
              {DIFF_SECTIONS.map((section) => {
                const Icon = section.icon;
                const list = diff.issueDiff[section.key];
                return (
                  <div key={section.key}>
                    <h4 className={cn('mb-2 flex items-center gap-1.5 text-sm font-semibold', section.tone)}>
                      <Icon className="size-4" />
                      {section.label}（{list.count}）
                    </h4>
                    <IssueDiffTable list={list} />
                  </div>
                );
              })}
            </TabsContent>
            <TabsContent value="files" className="space-y-4 pt-3">
              <p className="text-xs text-muted-foreground">
                两次快照分别含 {diff.fileDiff.filesA} / {diff.fileDiff.filesB} 个文件（不含 node_modules 与 .git）
              </p>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-success">
                  <FilePlus2 className="size-4" />
                  新增文件（{diff.fileDiff.added.length}）
                </h4>
                <div className="max-h-40 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
                  {diff.fileDiff.added.length === 0 ? (
                    <p className="text-muted-foreground">无</p>
                  ) : (
                    diff.fileDiff.added.map((path) => <div key={path}>{path}</div>)
                  )}
                </div>
              </div>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <FileMinus2 className="size-4" />
                  删除文件（{diff.fileDiff.removed.length}）
                </h4>
                <div className="max-h-40 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
                  {diff.fileDiff.removed.length === 0 ? (
                    <p className="text-muted-foreground">无</p>
                  ) : (
                    diff.fileDiff.removed.map((path) => <div key={path}>{path}</div>)
                  )}
                </div>
              </div>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-warning">
                  <FilePen className="size-4" />
                  修改文件（{diff.fileDiff.modified.length}）
                </h4>
                <div className="max-h-56 overflow-y-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-left text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">文件</th>
                        <th className="w-32 px-3 py-2 font-medium">行级变更</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.fileDiff.modified.map((file) => (
                        <tr key={file.path} className="border-t">
                          <td className="break-all px-3 py-1.5 font-mono">{file.path}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                            {file.diffable ? (
                              <>
                                <span className="text-success">+{file.addedLines}</span>{' '}
                                <span className="text-muted-foreground">/</span>{' '}
                                <span className="text-destructive">-{file.removedLines}</span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">内容已变化</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
