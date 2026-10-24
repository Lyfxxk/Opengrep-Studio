import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown,
  Download,
  Eye,
  FlaskConical,
  Folder,
  FolderOpen,
  PackageOpen,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { IRulePack, IRulePackCheckResult } from '@/data/rulepacks';
import { cn } from '@/lib/utils';
import { PACK_LANGUAGES } from '@/data/constants';
import { api } from '@/lib/api';
import RulePackContentDialog from './RulePackContentDialog';
import RulePackCreateDialog from './RulePackCreateDialog';

const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const VERDICT_LABELS: Record<string, { label: string; className: string }> = {
  pass: { label: '通过', className: 'text-success' },
  fail: { label: '未通过', className: 'text-warning' },
  error: { label: '错误', className: 'text-destructive' },
  unverified: { label: '未验证', className: 'text-muted-foreground' },
};

export default function RulePackTab() {
  const [rulePacks, setRulePacks] = useState<IRulePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<IRulePack | null>(null);
  const [deleteRefCount, setDeleteRefCount] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadLanguage, setUploadLanguage] = useState('Java');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [contentTarget, setContentTarget] = useState<IRulePack | null>(null);
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const [checking, setChecking] = useState<IRulePack | null>(null);
  const [checkResult, setCheckResult] = useState<IRulePackCheckResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const loadAll = useCallback(async () => {
    try {
      setRulePacks(await api.listRulePacks());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载规则包列表失败，请刷新重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  /** 内容对话框的关闭回调：稳定引用，避免 RulePackContentDialog 的加载 effect 因新函数引用重跑 */
  const handleContentDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setContentTarget(null);
  }, []);

  const handleToggle = async (pack: IRulePack, enabled: boolean) => {
    try {
      await api.toggleRulePack(pack.id, enabled);
      toast.success(enabled ? `规则包「${pack.name}」已启用` : `规则包「${pack.name}」已停用`);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新规则包状态失败，请重试');
    }
  };

  const handleFileChange = (file: File | undefined) => {
    if (!file) return;
    const yamlExt = /\.ya?ml$/i;
    if (!yamlExt.test(file.name)) {
      toast.error('仅支持 .yaml / .yml 规则包文件');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('规则包文件不能超过 1MB');
      return;
    }
    setUploadName(file.name.replace(yamlExt, ''));
    setUploadLanguage('Java');
    setUploadFile(file);
    setUploadOpen(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleUploadConfirm = async () => {
    const trimmed = uploadName.trim();
    if (!trimmed) {
      toast.error('请输入规则包名称');
      return;
    }
    if (!uploadFile) {
      toast.error('请重新选择规则包文件');
      return;
    }
    setSubmitting(true);
    try {
      await api.uploadRulePack(uploadFile, trimmed, uploadLanguage);
      toast.success(`规则包「${trimmed}」已上传`);
      setUploadOpen(false);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传规则包失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenDelete = async (pack: IRulePack) => {
    try {
      setDeleteRefCount(await api.countConfigsUsingRulePack(pack.id));
    } catch {
      setDeleteRefCount(0);
    }
    setDeleteTarget(pack);
  };

  const handleImportZip = (file: File | undefined) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      toast.error('仅支持 .zip 规则包压缩包');
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('规则包压缩包不能超过 20MB');
      return;
    }
    if (importInputRef.current) {
      importInputRef.current.value = '';
    }
    setSubmitting(true);
    api
      .importRulePack(file)
      .then((pack) => {
        toast.success(pack.message ?? `规则包「${pack.name}」已导入`);
        return loadAll();
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : '导入规则包失败，请重试');
      })
      .finally(() => setSubmitting(false));
  };

  const handleExport = (pack: IRulePack) => {
    window.open(api.exportRulePackUrl(pack.id), '_blank');
  };

  const handleCheck = async (pack: IRulePack) => {
    setChecking(pack);
    setCheckResult(null);
    try {
      const result = await api.checkRulePack(pack.id);
      setCheckResult(result);
      await loadAll();
    } catch (error) {
      setChecking(null);
      toast.error(error instanceof Error ? error.message : '质量检查失败，请重试');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteRulePack(deleteTarget.id);
      toast.success(`规则包「${deleteTarget.name}」已删除`);
      setDeleteTarget(null);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // 自定义包是日常工作区，始终展示；内置包随项目分发，默认收纳
  const customPacks = rulePacks.filter((pack) => !pack.builtin);
  const builtinPacks = rulePacks.filter((pack) => pack.builtin);
  const builtinRuleTotal = builtinPacks.reduce((sum, pack) => sum + pack.ruleCount, 0);

  const renderTableHeader = (
    <TableHeader>
      <TableRow>
        <TableHead className="whitespace-nowrap">名称</TableHead>
        <TableHead className="whitespace-nowrap">语言</TableHead>
        <TableHead className="whitespace-nowrap">规则条数</TableHead>
        <TableHead className="whitespace-nowrap">启用</TableHead>
        <TableHead className="whitespace-nowrap text-right">操作</TableHead>
      </TableRow>
    </TableHeader>
  );

  // 仅自定义包使用表格；内置包在下方以卡片流呈现
  const renderPackRow = (pack: IRulePack) => (
    <TableRow key={pack.id}>
      <TableCell className="font-medium">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{pack.name}</span>
          {pack.version && (
            <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
              v{pack.version}
            </Badge>
          )}
          {pack.lastCheck?.tier === 'verified' && (
            <Badge
              variant="outline"
              className="border-success/40 px-1.5 py-0 text-[11px] font-normal text-success"
            >
              样本已验证
            </Badge>
          )}
          {pack.manifest?.frameworks?.slice(0, 2).map((framework) => (
            <Badge key={framework} variant="secondary" className="px-1.5 py-0 text-[11px] font-normal">
              {framework}
            </Badge>
          ))}
        </div>
        {pack.manifest?.description && (
          <p className="mt-1 max-w-md truncate text-xs font-normal text-muted-foreground">
            {pack.manifest.description}
          </p>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="font-normal">
          {pack.language}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {pack.ruleCount}
        {Boolean(pack.sampleCount) && (
          <span className="ml-1 text-xs text-muted-foreground">+{pack.sampleCount} 样本</span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={pack.enabled}
          onCheckedChange={(checked) => void handleToggle(pack, checked)}
          aria-label={`启用 ${pack.name}`}
        />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={pack.isDir ? '逐规则运行样本检查' : '单文件包无样本，请导入可移植格式后检查'}
            disabled={!pack.isDir}
            onClick={() => void handleCheck(pack)}
          >
            <FlaskConical className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="导出为可移植规则包 zip"
            onClick={() => handleExport(pack)}
          >
            <Download className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={pack.isDir ? '目录式规则包暂不支持在线编辑' : '查看 / 编辑 YAML'}
            disabled={pack.isDir}
            onClick={() => setContentTarget(pack)}
          >
            <Eye className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            title="删除规则包"
            onClick={() => void handleOpenDelete(pack)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          规则包是 opengrep 格式的 YAML；也支持导入可移植规则包 zip（pack.yaml 清单 + 规则 + 正反例样本）
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button className="gap-1" onClick={() => setCreateOpen(true)}>
            新建规则包
          </Button>
          <Button variant="outline" className="gap-1" onClick={() => fileInputRef.current?.click()}>
            <Upload className="size-4" />
            上传 YAML
          </Button>
          <Button
            variant="outline"
            className="gap-1"
            disabled={submitting}
            onClick={() => importInputRef.current?.click()}
          >
            <Download className="size-4" />
            {submitting ? '导入中…' : '导入规则包'}
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          className="hidden"
          onChange={(event) => handleFileChange(event.target.files?.[0])}
        />
        <input
          ref={importInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(event) => handleImportZip(event.target.files?.[0])}
        />
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : rulePacks.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <PackageOpen className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                暂无规则包，点击「新建规则包」在线编写，或上传现成的 YAML 文件
              </p>
            </div>
          ) : (
            <div>
              {customPacks.length > 0 ? (
                <div className="w-full overflow-x-auto">
                  <Table>
                    {renderTableHeader}
                    <TableBody>{customPacks.map(renderPackRow)}</TableBody>
                  </Table>
                </div>
              ) : (
                <div className="m-4 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  暂无自定义规则包，点击右上角「新建规则包」在线编写，或上传现成的 YAML 文件
                </div>
              )}

              {/* 内置规则包：文件夹式分区头 + 缩进浅底卡片流，与上方自定义数据行形成父子层级 */}
              <div className="p-4 pt-3">
                <button
                  type="button"
                  aria-expanded={builtinOpen}
                  onClick={() => setBuiltinOpen((open) => !open)}
                  className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted/60"
                >
                  {builtinOpen ? (
                    <FolderOpen className="size-4 shrink-0 text-primary" />
                  ) : (
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="shrink-0">内置规则包</span>
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    {builtinPacks.length} 个
                  </Badge>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground">
                    共 {builtinRuleTotal} 条规则
                  </span>
                  <span className="ml-auto hidden truncate text-xs font-normal text-muted-foreground/80 sm:inline">
                    随项目分发，仅可查看与启停
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform',
                      builtinOpen && 'rotate-180',
                    )}
                  />
                </button>
                {builtinOpen && (
                  <div className="ml-5 border-l-2 border-border/70 pl-4 sm:ml-6 sm:pl-6">
                    <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-muted/25 p-3 lg:grid-cols-2">
                      {builtinPacks.map((pack) => (
                        <div
                          key={pack.id}
                          className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{pack.name}</p>
                            <div className="mt-1.5 flex items-center gap-2">
                              <Badge
                                variant="secondary"
                                className="px-1.5 py-0 text-[11px] font-normal"
                              >
                                {pack.language}
                              </Badge>
                              <span className="text-xs tabular-nums text-muted-foreground">
                                {pack.ruleCount} 条规则
                              </span>
                            </div>
                          </div>
                          <Switch
                            checked={pack.enabled}
                            onCheckedChange={(checked) => void handleToggle(pack, checked)}
                            aria-label={`启用 ${pack.name}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0"
                            title="查看 YAML（内置包只读）"
                            onClick={() => setContentTarget(pack)}
                          >
                            <Eye className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 在线创建 */}
      <RulePackCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void loadAll()}
      />

      {/* 查看 / 编辑 */}
      <RulePackContentDialog
        open={contentTarget !== null}
        onOpenChange={handleContentDialogOpenChange}
        pack={contentTarget}
        onSaved={() => void loadAll()}
      />

      {/* 上传确认 */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>确认规则包信息</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rulepack-name">规则包名称</Label>
              <Input
                id="rulepack-name"
                value={uploadName}
                maxLength={30}
                placeholder="默认取文件名，可修改"
                onChange={(event) => setUploadName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>适用语言</Label>
              <Select value={uploadLanguage} onValueChange={setUploadLanguage}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PACK_LANGUAGES.map((language) => (
                    <SelectItem key={language} value={language}>
                      {language}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>
              取消
            </Button>
            <Button disabled={submitting} onClick={() => void handleUploadConfirm()}>
              {submitting ? '上传中…' : '确认上传'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 质量检查结果 */}
      <Dialog
        open={checking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setChecking(null);
            setCheckResult(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>质量检查 · {checking?.name}</DialogTitle>
          </DialogHeader>
          {!checkResult ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <FlaskConical className="size-4 animate-pulse" />
              正在逐规则运行正反例样本（复用规则实验室引擎），视规则数量需要数十秒…
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    checkResult.tier === 'verified'
                      ? 'border-success/40 font-normal text-success'
                      : 'font-normal text-muted-foreground'
                  }
                >
                  {checkResult.tier === 'verified' ? 'verified · 样本全通过' : 'basic · 无样本或未全通过'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  通过 {checkResult.summary.passed} · 未通过 {checkResult.summary.failed} · 错误{' '}
                  {checkResult.summary.errors} · 无样本 {checkResult.summary.unverified} · 耗时{' '}
                  {(checkResult.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {checkResult.items.map((item) => (
                  <div
                    key={`${item.ruleFile}-${item.ruleId}`}
                    className="rounded-md border bg-muted/30 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={cn(
                          'font-medium',
                          VERDICT_LABELS[item.verdict]?.className ?? 'text-muted-foreground',
                        )}
                      >
                        {VERDICT_LABELS[item.verdict]?.label ?? item.verdict}
                      </span>
                      <span className="font-mono">{item.ruleId}</span>
                      <span className="text-muted-foreground">
                        {item.ruleFile} · 正例 {item.positiveCount} / 反例 {item.negativeCount}
                      </span>
                    </div>
                    {item.detail && (
                      <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setChecking(null); setCheckResult(null); }}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除规则包</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除规则包「{deleteTarget?.name}」？
              {deleteRefCount > 0
                ? `${deleteRefCount} 个配置引用了此规则包，删除后这些配置将移除对它的勾选。`
                : '删除后不可恢复。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
