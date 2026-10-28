import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { Checkbox } from '@/components/ui/checkbox';
import BatchDeleteBar from '@/components/BatchDeleteBar';
import BatchDeleteConfirm from '@/components/BatchDeleteConfirm';
import { useRowSelection } from '@/lib/useRowSelection';
import { usePagedList } from '@/lib/usePagedList';
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
import { usePackDisplayName } from '@/lib/packName';
import Pagination from '@/components/Pagination';
import { PACK_LANGUAGES } from '@/data/constants';
import { api } from '@/lib/api';
import RulePackContentDialog from './RulePackContentDialog';
import RulePackCreateDialog from './RulePackCreateDialog';

const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const VERDICT_CLASSES: Record<string, string> = {
  pass: 'text-success',
  fail: 'text-warning',
  error: 'text-destructive',
  unverified: 'text-muted-foreground',
};

/** 已知判定值翻键翻译，未知值原样展示 */
function verdictLabel(
  v: string,
  t: (key: 'rulePacks.verdictPass' | 'rulePacks.verdictFail' | 'rulePacks.verdictError' | 'rulePacks.verdictUnverified') => string,
): string {
  if (v === 'pass') return t('rulePacks.verdictPass');
  if (v === 'fail') return t('rulePacks.verdictFail');
  if (v === 'error') return t('rulePacks.verdictError');
  if (v === 'unverified') return t('rulePacks.verdictUnverified');
  return v;
}

export default function RulePackTab() {
  const { t } = useTranslation();
  const packDisplayName = usePackDisplayName();
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
      toast.error(error instanceof Error ? error.message : t('rulePacks.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      toast.success(
        t(enabled ? 'rulePacks.toggleEnabledToast' : 'rulePacks.toggleDisabledToast', {
          name: packDisplayName(pack.name, pack.id),
        }),
      );
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('rulePacks.updateFailed'));
    }
  };

  const handleFileChange = (file: File | undefined) => {
    if (!file) return;
    const yamlExt = /\.ya?ml$/i;
    if (!yamlExt.test(file.name)) {
      toast.error(t('rulePacks.yamlOnly'));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(t('rulePacks.yamlTooLarge'));
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
      toast.error(t('rulePacks.nameRequired'));
      return;
    }
    if (!uploadFile) {
      toast.error(t('rulePacks.fileRequired'));
      return;
    }
    setSubmitting(true);
    try {
      await api.uploadRulePack(uploadFile, trimmed, uploadLanguage);
      toast.success(t('rulePacks.uploadedToast', { name: trimmed }));
      setUploadOpen(false);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('rulePacks.uploadCheckFailed'));
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
      toast.error(t('rulePacks.zipOnly'));
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error(t('rulePacks.zipTooLarge'));
      return;
    }
    if (importInputRef.current) {
      importInputRef.current.value = '';
    }
    setSubmitting(true);
    api
      .importRulePack(file)
      .then((pack) => {
        toast.success(pack.message ?? t('rulePacks.importedToast', { name: pack.name }));
        return loadAll();
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t('rulePacks.importCheckFailed'));
      })
      .finally(() => setSubmitting(false));
  };

  const handleExport = (pack: IRulePack) => {
    window.open(api.exportRulePackUrl(pack.id), '_blank');
  };

  // 质量检查请求序号：检查耗时数十秒，期间关闭对话框或改查别的包时，晚到的旧响应不得覆盖新状态
  const checkSeqRef = useRef(0);

  const handleCheck = async (pack: IRulePack) => {
    const seq = ++checkSeqRef.current;
    setChecking(pack);
    setCheckResult(null);
    try {
      const result = await api.checkRulePack(pack.id);
      if (seq !== checkSeqRef.current) return;
      setCheckResult(result);
      await loadAll();
    } catch (error) {
      if (seq !== checkSeqRef.current) return;
      setChecking(null);
      toast.error(error instanceof Error ? error.message : t('rulePacks.checkFailed'));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteRulePack(deleteTarget.id);
      toast.success(t('rulePacks.deletedToast', { name: deleteTarget.name }));
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

  // 分页：自定义包表格与内置包卡片流各自翻页，删行 / 导入后夹页码防空页
  const customPageSize = 20;
  const builtinPageSize = 8;
  const {
    page: safeCustomPage,
    setPage: setCustomPage,
    pageCount: customPageCount,
    slice: pagedCustomPacks,
  } = usePagedList(customPacks, customPageSize);
  const {
    page: safeBuiltinPage,
    setPage: setBuiltinPage,
    pageCount: builtinPageCount,
    slice: pagedBuiltinPacks,
  } = usePagedList(builtinPacks, builtinPageSize);

  // 批量删除只覆盖自定义包表格（内置包在下方以卡片流呈现，不参与勾选）
  const selection = useRowSelection(customPacks.map((pack) => pack.id));
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 逐个调用单删接口：某一项失败不影响其余项，最后汇总报数
  const handleBatchDelete = async () => {
    const ids = [...selection.selected];
    setBatchConfirmOpen(false);
    setBatchDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteRulePack(id);
      } catch {
        failed += 1;
      }
    }
    setBatchDeleting(false);
    selection.clear();
    await loadAll();
    if (failed === 0) toast.success(t('rulePacks.batchDeleted', { count: ids.length }));
    else toast.warning(t('rulePacks.batchPartial', { count: ids.length - failed, failed }));
  };

  const renderTableHeader = (
    <TableHeader>
      <TableRow>
        <TableHead className="w-10">
          <Checkbox
            checked={selection.allSelected ? true : selection.someSelected ? 'indeterminate' : false}
            onCheckedChange={() => selection.toggleAll()}
            aria-label={t('rulePacks.selectAllAria')}
          />
        </TableHead>
        <TableHead className="whitespace-nowrap">{t('rulePacks.colName')}</TableHead>
        <TableHead className="whitespace-nowrap">{t('rulePacks.colLanguage')}</TableHead>
        <TableHead className="whitespace-nowrap">{t('rulePacks.colRuleCount')}</TableHead>
        <TableHead className="whitespace-nowrap">{t('rulePacks.colEnabled')}</TableHead>
        <TableHead className="whitespace-nowrap text-right">{t('common.actions')}</TableHead>
      </TableRow>
    </TableHeader>
  );

  // 仅自定义包使用表格；内置包在下方以卡片流呈现
  const renderPackRow = (pack: IRulePack) => (
    <TableRow key={pack.id}>
      <TableCell className="w-10">
        <Checkbox
          checked={selection.selected.has(pack.id)}
          onCheckedChange={() => selection.toggle(pack.id)}
          aria-label={t('rulePacks.rowSelectAria', { name: pack.name })}
        />
      </TableCell>
      <TableCell className="font-medium">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{packDisplayName(pack.name, pack.id)}</span>
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
              {t('rulePacks.verifiedBadge')}
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
          <span className="ml-1 text-xs text-muted-foreground">
            {t('rulePacks.sampleSuffix', { count: pack.sampleCount })}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={pack.enabled}
          onCheckedChange={(checked) => void handleToggle(pack, checked)}
          aria-label={t('rulePacks.enableAria', { name: pack.name })}
        />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={pack.isDir ? t('rulePacks.checkDirTitle') : t('rulePacks.checkSingleTitle')}
            disabled={!pack.isDir}
            onClick={() => void handleCheck(pack)}
          >
            <FlaskConical className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={t('rulePacks.exportTitle')}
            onClick={() => handleExport(pack)}
          >
            <Download className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title={pack.isDir ? t('rulePacks.editDirTitle') : t('rulePacks.editTitle')}
            disabled={pack.isDir}
            onClick={() => setContentTarget(pack)}
          >
            <Eye className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            title={t('rulePacks.deleteActionTitle')}
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
        <p className="text-sm text-muted-foreground">{t('rulePacks.tabSubtitle')}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button className="gap-1" onClick={() => setCreateOpen(true)}>
            {t('rulePacks.createBtn')}
          </Button>
          <Button variant="outline" className="gap-1" onClick={() => fileInputRef.current?.click()}>
            <Upload className="size-4" />
            {t('rulePacks.uploadYamlBtn')}
          </Button>
          <Button
            variant="outline"
            className="gap-1"
            disabled={submitting}
            onClick={() => importInputRef.current?.click()}
          >
            <Download className="size-4" />
            {submitting ? t('rulePacks.importing') : t('rulePacks.importBtn')}
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

      <BatchDeleteBar
        count={selection.count}
        entity="rulePack"
        deleting={batchDeleting}
        onDelete={() => setBatchConfirmOpen(true)}
        onClear={selection.clear}
      />

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
              <p className="text-sm text-muted-foreground">{t('rulePacks.emptyAll')}</p>
            </div>
          ) : (
            <div>
              {customPacks.length > 0 ? (
                <div className="w-full overflow-x-auto">
                  <Table>
                    {renderTableHeader}
                    <TableBody>{pagedCustomPacks.map(renderPackRow)}</TableBody>
                  </Table>
                </div>
              ) : (
                <div className="m-4 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  {t('rulePacks.emptyCustom')}
                </div>
              )}

              {customPacks.length > customPageSize && (
                <Pagination
                  page={safeCustomPage}
                  pageCount={customPageCount}
                  onPage={setCustomPage}
                  className="border-t px-4 py-2"
                />
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
                  <span className="shrink-0">{t('configs.builtinPacksTitle')}</span>
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    {t('configs.builtinCount', { count: builtinPacks.length })}
                  </Badge>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground">
                    {t('rulePacks.builtinRulesTotal', { count: builtinRuleTotal })}
                  </span>
                  <span className="ml-auto hidden truncate text-xs font-normal text-muted-foreground/80 sm:inline">
                    {t('rulePacks.builtinReadOnlyHint')}
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
                      {pagedBuiltinPacks.map((pack) => (
                        <div
                          key={pack.id}
                          className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {packDisplayName(pack.name, pack.id)}
                            </p>
                            <div className="mt-1.5 flex items-center gap-2">
                              <Badge
                                variant="secondary"
                                className="px-1.5 py-0 text-[11px] font-normal"
                              >
                                {pack.language}
                              </Badge>
                              <span className="text-xs tabular-nums text-muted-foreground">
                                {t('configs.ruleCount', { count: pack.ruleCount })}
                              </span>
                            </div>
                          </div>
                          <Switch
                            checked={pack.enabled}
                            onCheckedChange={(checked) => void handleToggle(pack, checked)}
                            aria-label={t('rulePacks.enableAria', { name: pack.name })}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0"
                            title={t('rulePacks.builtinViewTitle')}
                            onClick={() => setContentTarget(pack)}
                          >
                            <Eye className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    {builtinPacks.length > builtinPageSize && (
                      <Pagination
                        page={safeBuiltinPage}
                        pageCount={builtinPageCount}
                        onPage={setBuiltinPage}
                        className="pb-3"
                      />
                    )}
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
            <DialogTitle>{t('rulePacks.uploadDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rulepack-name">{t('rulePacks.uploadNameLabel')}</Label>
              <Input
                id="rulepack-name"
                value={uploadName}
                maxLength={30}
                placeholder={t('rulePacks.uploadNamePlaceholder')}
                onChange={(event) => setUploadName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('rulePacks.uploadLangLabel')}</Label>
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
              {t('common.cancel')}
            </Button>
            <Button disabled={submitting} onClick={() => void handleUploadConfirm()}>
              {submitting ? t('rulePacks.uploading') : t('rulePacks.uploadConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 质量检查结果 */}
      <Dialog
        open={checking !== null}
        onOpenChange={(open) => {
          if (!open) {
            // 递增序号让在途请求的迟到响应作废，避免结果窗口重开后闪现旧包的检查结果
            checkSeqRef.current += 1;
            setChecking(null);
            setCheckResult(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('rulePacks.checkDialogTitle', { name: checking?.name ?? '' })}</DialogTitle>
          </DialogHeader>
          {!checkResult ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <FlaskConical className="size-4 animate-pulse" />
              {t('rulePacks.checkRunning')}
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
                  {checkResult.tier === 'verified' ? t('rulePacks.checkVerifiedBadge') : t('rulePacks.checkBasicBadge')}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t('rulePacks.checkSummary', {
                    passed: checkResult.summary.passed,
                    failed: checkResult.summary.failed,
                    errors: checkResult.summary.errors,
                    unverified: checkResult.summary.unverified,
                    duration: (checkResult.durationMs / 1000).toFixed(1),
                  })}
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
                          VERDICT_CLASSES[item.verdict] ?? 'text-muted-foreground',
                        )}
                      >
                        {verdictLabel(item.verdict, t)}
                      </span>
                      <span className="font-mono">{item.ruleId}</span>
                      <span className="text-muted-foreground">
                        {item.ruleFile} · {t('rulePacks.itemSamples', { pos: item.positiveCount, neg: item.negativeCount })}
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
              {t('common.close')}
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
            <AlertDialogTitle>{t('rulePacks.deleteDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('rulePacks.deleteDesc', { name: deleteTarget?.name ?? '' })}
              {deleteRefCount > 0
                ? t('rulePacks.deleteRefSuffix', { count: deleteRefCount })
                : t('configs.deletePlainSuffix')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.confirmDelete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BatchDeleteConfirm
        open={batchConfirmOpen}
        entity="rulePack"
        count={selection.count}
        extra={t('rulePacks.batchExtra')}
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
