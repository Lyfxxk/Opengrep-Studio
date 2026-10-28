import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { IScanDiff, IScanDiffIssueList } from '@/data/diffs';
import { attachProjectNames, type ScanWithProject } from '@/lib/scans';
import { formatDateTime } from '@/lib/format';
import { SEVERITY_BADGE_CLASS } from '@/lib/severity';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

interface CompareDialogProps {
  scanId: string;
  onClose: () => void;
}

function IssueDiffTable({ list }: { list: IScanDiffIssueList }) {
  const { t } = useTranslation();
  if (list.count === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('compare.empty')}</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t('compare.thLocation')}</th>
            <th className="px-3 py-2 font-medium">{t('compare.thRule')}</th>
            <th className="px-3 py-2 font-medium">{t('compare.thSeverity')}</th>
            <th className="px-3 py-2 font-medium">{t('compare.thDescription')}</th>
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
                  {t(`severity.${item.severity}`)}
                </Badge>
              </td>
              <td className="max-w-[280px] truncate px-3 py-1.5 text-muted-foreground">{item.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.count > list.items.length && (
        <p className="border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          {t('compare.truncated', { shown: list.items.length, total: list.count })}
        </p>
      )}
    </div>
  );
}

const DIFF_SECTIONS: Array<{ key: 'new' | 'fixed' | 'remaining'; labelKey: 'compare.sectionNew' | 'compare.sectionFixed' | 'compare.sectionRemaining'; icon: typeof CircleAlert; tone: string }> = [
  { key: 'new', labelKey: 'compare.sectionNew', icon: CircleAlert, tone: 'text-destructive' },
  { key: 'fixed', labelKey: 'compare.sectionFixed', icon: CircleDot, tone: 'text-success' },
  { key: 'remaining', labelKey: 'compare.sectionRemaining', icon: CircleDot, tone: 'text-warning' },
];

/** 双快照对比对话框：任选两次已完成扫描（含跨项目），问题级 + 文件级差异 */
export default function CompareDialog({ scanId, onClose }: CompareDialogProps) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<ScanWithProject[] | null>(null);
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
          <DialogTitle>{t('compare.title')}</DialogTitle>
          <DialogDescription>{t('compare.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={againstId}
            onValueChange={(id) => {
              setAgainstId(id);
              // 换对比目标后上一次的对比结果立即失效，避免旧结果被误读为新目标的结论
              setDiff(null);
            }}
          >
            <SelectTrigger className="min-w-[320px] flex-1">
              <SelectValue placeholder={t('compare.targetPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(
                (candidates ?? []).reduce<Record<string, ScanWithProject[]>>((acc, scan) => {
                  // 接口按时间倒序返回，这里保持遇到顺序即可：组按最近扫描排前，组内时间倒序
                  (acc[scan.projectName ?? scan.projectId] ??= []).push(scan);
                  return acc;
                }, {}),
              ).map(([project, groupScans]) => (
                <SelectGroup key={project}>
                  <SelectLabel>{project}</SelectLabel>
                  {groupScans.map((scan) => (
                    <SelectItem key={scan.id} value={scan.id}>
                      {t('compare.targetItem', {
                        id: scan.id,
                        time: formatDateTime(scan.scannedAt),
                      })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!againstId || loading} onClick={() => void runDiff()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('compare.runBtn')}
          </Button>
        </div>

        {/* 跨引擎版本的基线对比有噪音：新引擎会新增检测、修复误报，先提示再让人看差异 */}
        {diff?.engine?.mismatch && (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {t('compare.engineMismatch', {
                from: diff.engine.against ?? t('compare.unknownVersion'),
                to: diff.engine.current ?? t('compare.unknownVersion'),
              })}
            </span>
          </p>
        )}

        {diff && (
          <Tabs defaultValue="issues">
            <TabsList>
              <TabsTrigger value="issues">{t('compare.tabIssues')}</TabsTrigger>
              <TabsTrigger value="files">{t('compare.tabFiles')}</TabsTrigger>
            </TabsList>
            <TabsContent value="issues" className="space-y-4 pt-3">
              {DIFF_SECTIONS.map((section) => {
                const Icon = section.icon;
                const list = diff.issueDiff[section.key];
                return (
                  <div key={section.key}>
                    <h4 className={cn('mb-2 flex items-center gap-1.5 text-sm font-semibold', section.tone)}>
                      <Icon className="size-4" />
                      {t(section.labelKey, { count: list.count })}
                    </h4>
                    <IssueDiffTable list={list} />
                  </div>
                );
              })}
            </TabsContent>
            <TabsContent value="files" className="space-y-4 pt-3">
              <p className="text-xs text-muted-foreground">
                {t('compare.filesSummary', { a: diff.fileDiff.filesA, b: diff.fileDiff.filesB })}
              </p>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-success">
                  <FilePlus2 className="size-4" />
                  {t('compare.addedFiles', { count: diff.fileDiff.added.length })}
                </h4>
                <div className="max-h-40 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
                  {diff.fileDiff.added.length === 0 ? (
                    <p className="text-muted-foreground">{t('compare.empty')}</p>
                  ) : (
                    diff.fileDiff.added.map((path) => <div key={path}>{path}</div>)
                  )}
                </div>
              </div>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <FileMinus2 className="size-4" />
                  {t('compare.removedFiles', { count: diff.fileDiff.removed.length })}
                </h4>
                <div className="max-h-40 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
                  {diff.fileDiff.removed.length === 0 ? (
                    <p className="text-muted-foreground">{t('compare.empty')}</p>
                  ) : (
                    diff.fileDiff.removed.map((path) => <div key={path}>{path}</div>)
                  )}
                </div>
              </div>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-warning">
                  <FilePen className="size-4" />
                  {t('compare.modifiedFiles', { count: diff.fileDiff.modified.length })}
                </h4>
                <div className="max-h-56 overflow-y-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-left text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t('compare.thFile')}</th>
                        <th className="w-32 px-3 py-2 font-medium">{t('compare.thLineChanges')}</th>
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
                              <span className="text-muted-foreground">{t('compare.contentChanged')}</span>
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
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
