import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
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
import BatchDeleteBar from '@/components/BatchDeleteBar';
import BatchDeleteConfirm from '@/components/BatchDeleteConfirm';
import { useRowSelection } from '@/lib/useRowSelection';
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
import ConfigFormDialog, { type ConfigDialogTarget } from './ConfigFormDialog';

function toFormValues(config: IConfig): ConfigFormValues {
  return {
    name: config.name,
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
  const [configs, setConfigs] = useState<IConfig[]>([]);
  const [projects, setProjects] = useState<IProject[]>([]);
  const [rulePacks, setRulePacks] = useState<IRulePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState<ConfigDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IConfig | null>(null);
  const selection = useRowSelection(configs.map((config) => config.id));
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
      toast.error(error instanceof Error ? error.message : '加载配置列表失败，请刷新重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
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
      values: { ...toFormValues(config), name: `${config.name} 副本` },
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
      toast.success('配置已保存');
      setDialogOpen(false);
      setTarget(null);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存配置失败，请重试');
    }
  };

  const boundCountOf = (configId: string) =>
    projects.filter((project) => project.configId === configId).length;

  const deleteBoundCount = deleteTarget ? boundCountOf(deleteTarget.id) : 0;

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteConfig(deleteTarget.id);
      toast.success(
        deleteBoundCount > 0
          ? `配置已删除，${deleteBoundCount} 个项目的绑定已解除`
          : '配置已删除',
      );
      setDeleteTarget(null);
      await loadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除配置失败，请重试');
    }
  };

  const packNameOf = (packId: string) =>
    rulePacks.find((pack) => pack.id === packId)?.name;

  // 逐个调用单删接口：某一项失败不影响其余项，最后汇总报数
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
    if (failed === 0) toast.success(`已删除 ${ids.length} 个配置`);
    else toast.warning(`已删除 ${ids.length - failed} 个配置，${failed} 个失败`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          扫描配置决定规则包选择、排除路径与引擎参数，可绑定到具体项目
        </p>
        <Button className="gap-1" onClick={handleCreate}>
          <Plus className="size-4" />
          新建配置
        </Button>
      </div>

      <BatchDeleteBar
        count={selection.count}
        label="配置"
        deleting={batchDeleting}
        onDelete={() => setBatchConfirmOpen(true)}
        onClear={selection.clear}
      />

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
              <p className="text-sm text-muted-foreground">
                暂无扫描配置，点击「新建配置」创建第一个配置
              </p>
              <Button className="gap-1" onClick={handleCreate}>
                <Plus className="size-4" />
                新建配置
              </Button>
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
                        aria-label="全选配置"
                      />
                    </TableHead>
                    <TableHead className="whitespace-nowrap">配置名称</TableHead>
                    <TableHead className="whitespace-nowrap">规则包</TableHead>
                    <TableHead className="whitespace-nowrap">排除路径</TableHead>
                    <TableHead className="whitespace-nowrap">参数摘要</TableHead>
                    <TableHead className="whitespace-nowrap">绑定项目数</TableHead>
                    <TableHead className="whitespace-nowrap">创建时间</TableHead>
                    <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {configs.map((config) => (
                    <TableRow key={config.id}>
                      <TableCell className="w-10">
                        <Checkbox
                          checked={selection.selected.has(config.id)}
                          onCheckedChange={() => selection.toggle(config.id)}
                          aria-label={`选择配置 ${config.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="block font-medium">{config.name}</span>
                        {config.description && (
                          <span className="block max-w-[220px] truncate text-xs text-muted-foreground">
                            {config.description}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {/* key 用包 id：包名不保证唯一（同名包可并存），用名称会撞 key */}
                          {config.rulePackIds.slice(0, 2).map((packId) => (
                            <Badge
                              key={packId}
                              variant="secondary"
                              className="font-normal"
                            >
                              {packNameOf(packId) ?? packId}
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
                                      className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/15 bg-white/10 px-2 py-1"
                                    >
                                      <Package className="size-3 shrink-0 opacity-70" />
                                      {packNameOf(packId) ?? packId}
                                    </span>
                                  ))}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {config.excludes.length} 条
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        超时 {config.timeoutSeconds}s · 并发 {config.jobs}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {boundCountOf(config.id)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {formatDateTime(config.createdAt)}
                      </TableCell>
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
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => handleCopy(config)}>
                              <Plus className="size-4" />
                              复制
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setDeleteTarget(config)}
                            >
                              <Trash2 className="size-4" />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
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
            <AlertDialogTitle>确认删除配置</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除配置「{deleteTarget?.name}」？
              {deleteBoundCount > 0
                ? `${deleteBoundCount} 个项目正在使用此配置，删除后这些项目将变为未绑定状态，需重新绑定后才能扫描。`
                : '删除后不可恢复。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <BatchDeleteConfirm
        open={batchConfirmOpen}
        label="配置"
        count={selection.count}
        extra="正在使用中的配置删除后，对应项目将自动解除绑定。"
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
