import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
import { useConfigDisplayName, usePackDisplayName } from '@/lib/displayNames';
import { MoreHorizontal, Package, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
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
import BatchDeleteBar, { BatchDeleteConfirm } from '@/components/BatchDeleteBar';
import { useRowSelection } from '@/lib/usePagedList';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { type IConfig } from '@/data/configs';
import type { IProject } from '@/data/projects';
import type { IRulePack } from '@/data/rulepacks';
import {
  api,
  type ConfigFormValues,
} from '@/lib/api';
import { hasRole } from '@/lib/auth';
import ConfigFormDialog, { type ConfigDialogTarget } from './ConfigFormDialog';

function toFormValues(config: IConfig, name?: string): ConfigFormValues {
  return {
    name: name ?? config.name,
    description: config.description,
    rulePackIds: config.rulePackIds,
    excludes: config.excludes,
    includes: config.includes,
    timeoutSeconds: config.timeoutSeconds,
    jobs: config.jobs,
    maxTargetBytes: config.maxTargetBytes,
  };
}

export default function ScanConfigTab() {
  const { t } = useTranslation();
  const configDisplay = useConfigDisplayName();
  const packDisplayName = usePackDisplayName();
  const isAdmin = hasRole('admin');
  const [configs, setConfigs] = useState<IConfig[]>([]);
  const [projects, setProjects] = useState<IProject[]>([]);
  const [rulePacks, setRulePacks] = useState<IRulePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState<ConfigDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IConfig | null>(null);
  const selection = useRowSelection(configs.filter((config) => !config.isProtected).map((config) => config.id));
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [configList, projectList, packList] = await Promise.all([
        api.listConfigs(),
        api.listProjects(),
        api.listRulePacks(),
      ]);
      setConfigs(configList);
      setProjects(projectList);
      setRulePacks(packList);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('configs.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void Promise.resolve().then(() => void loadAll());
  }, [loadAll]);

  const handleCreate = () => {
    const defaultPackIds = rulePacks
      .filter((pack) => pack.enabled)
      .map((pack) => pack.id);
    setTarget({
      values: {
        name: '',
        description: '',
        rulePackIds: defaultPackIds,
        excludes: [],
        includes: [],
        timeoutSeconds: 5,
        jobs: 4,
        maxTargetBytes: 1000000,
      },
    });
    setDialogOpen(true);
  };

  const handleEdit = (config: IConfig) => {
    setTarget({
      id: config.id,
      values: toFormValues(config),
    });
    setDialogOpen(true);
  };

  const handleCopy = (config: IConfig) => {
    setTarget({
      values: { ...toFormValues(config), name: `${configDisplay(config).name}${t('configs.copySuffix')}` },
    });
    setDialogOpen(true);
  };

  const handleSave = async (values: ConfigFormValues, configId?: string) => {
    try {
      if (configId) {
        await api.updateConfig(configId, values);
      } else {
        await api.createConfig(values);
      }
      setDialogOpen(false);
      setTarget(null);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('configs.saveFailed'));
    }
  };

  const boundCountOf = (configId: string) =>
    projects.filter((project) => project.configId === configId).length;

  const deleteBoundCount = deleteTarget ? boundCountOf(deleteTarget.id) : 0;

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteConfig(deleteTarget.id);
      if (deleteBoundCount > 0) {
        toast.success(t('configs.deletedUnboundToast', { count: deleteBoundCount }));
      }
      setDeleteTarget(null);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('configs.deleteFailed'));
    }
  };

  const packNameOf = (packId: string) => {
    const pack = rulePacks.find((item) => item.id === packId);
    return pack ? packDisplayName(pack.name, pack.id) : undefined;
  };

  const packDisabledOf = (packId: string) =>
    rulePacks.find((pack) => pack.id === packId)?.enabled === false;

  const handleBatchDelete = async () => {
    const ids = [...selection.selected];
    setBatchConfirmOpen(false);
    setBatchDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteConfig(id);
      } catch {
        failed += 1;
      }
    }
    setBatchDeleting(false);
    selection.clear();
    await loadAll();
    if (failed > 0) toast.warning(t('configs.batchPartial', { count: ids.length - failed, failed }));
  };

  return (
    <div className="space-y-4">
      <h1 className="mb-6 text-xl font-semibold">{t('configs.pageTitle')}</h1>
      {isAdmin && (
        <div className="flex justify-end">
          <Button className="gap-1" onClick={handleCreate}>
            <Plus className="size-4" />
            {t('configs.newConfig')}
          </Button>
        </div>
      )}

      {isAdmin && (
        <BatchDeleteBar
          count={selection.count}
          entity="config"
          deleting={batchDeleting}
          onDelete={() => setBatchConfirmOpen(true)}
          onClear={selection.clear}
        />
      )}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : configs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <SlidersHorizontal className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('configs.empty')}</p>
              {isAdmin && (
                <Button className="gap-1" onClick={handleCreate}>
                  <Plus className="size-4" />
                  {t('configs.newConfig')}
                </Button>
              )}
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {isAdmin && (
                      <TableHead className="w-10">
                        <Checkbox
                          checked={selection.allSelected ? true : selection.someSelected ? 'indeterminate' : false}
                          onCheckedChange={() => selection.toggleAll()}
                          aria-label={t('configs.selectAllAria')}
                        />
                      </TableHead>
                    )}
                    <TableHead className="whitespace-nowrap">{t('configs.colName')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('configs.colRulePacks')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('configs.colExcludes')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('configs.colParams')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('configs.colBoundProjects')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('configs.colCreatedAt')}</TableHead>
                    {isAdmin && (
                      <TableHead className="whitespace-nowrap text-right">{t('common.actions')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {configs.map((config) => (
                    <TableRow key={config.id}>
                      {isAdmin && (
                        <TableCell className="w-10">
                          <Checkbox
                            checked={selection.selected.has(config.id)}
                            onCheckedChange={() => selection.toggle(config.id)}
                            disabled={config.isProtected}
                            aria-label={t('configs.rowSelectAria', { name: configDisplay(config).name })}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <span className="flex items-center gap-1.5 font-medium">
                          {configDisplay(config).name}
                          {config.isProtected && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                                  {t('configs.fallbackBadge')}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-[280px] p-2">
                                {t('configs.fallbackHint')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                        {configDisplay(config).description && (
                          <span className="block max-w-[220px] truncate text-xs text-muted-foreground">
                            {configDisplay(config).description}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {config.rulePackIds.slice(0, 2).map((packId) => (
                            <Badge
                              key={packId}
                              variant="secondary"
                              className="font-normal"
                            >
                              {packNameOf(packId) ?? packId}
                              {packDisabledOf(packId) && (
                                <span className="text-destructive">
                                  {t('configs.disabledSuffix')}
                                </span>
                              )}
                            </Badge>
                          ))}
                          {config.rulePackIds.length > 2 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="cursor-default font-normal">
                                  +{config.rulePackIds.length - 2}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-[320px] p-2">
                                <div className="flex flex-col gap-1.5">
                                  {config.rulePackIds.slice(2).map((packId) => (
                                    <span
                                      key={packId}
                                      className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-background/15 bg-background/10 px-2 py-1"
                                    >
                                      <Package className="size-3 shrink-0 opacity-70" />
                                      {packNameOf(packId) ?? packId}
                                      {packDisabledOf(packId) && (
                                        <span className="text-destructive">
                                          {t('configs.disabledSuffix')}
                                        </span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {t('configs.excludesCount', { count: config.excludes.length })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {t('configs.paramsSummary', { timeout: config.timeoutSeconds, jobs: config.jobs })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {boundCountOf(config.id)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {formatDateTime(config.createdAt)}
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-8">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => handleEdit(config)}>
                                <Pencil className="size-4" />
                                {t('common.edit')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => handleCopy(config)}>
                                <Plus className="size-4" />
                                {t('configs.copy')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                disabled={config.isProtected}
                                title={config.isProtected ? t('configs.fallbackHint') : undefined}
                                onSelect={() => setDeleteTarget(config)}
                              >
                                <Trash2 className="size-4" />
                                {t('common.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfigFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setTarget(null);
          }
        }}
        target={target}
        rulePacks={rulePacks}
        existingConfigs={configs}
        onSubmit={handleSave}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('configs.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('configs.deleteDesc', { name: deleteTarget?.name ?? '' })}
              {deleteBoundCount > 0
                ? t('configs.deleteBoundSuffix', { count: deleteBoundCount })
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
        entity="config"
        count={selection.count}
        extra={t('configs.batchExtra')}
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
