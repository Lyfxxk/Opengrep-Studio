import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
import { FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { IProject } from '@/data/projects';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import NewProjectDialog from './NewProjectDialog';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<IProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<IProject | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IProject | null>(null);
  const selection = useRowSelection(projects.map((project) => project.id));
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (error) {
      toast.error(`加载项目列表失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = async (
    values: { name: string; description: string },
    projectId?: string,
  ) => {
    try {
      if (projectId) {
        await api.updateProject(projectId, values);
        toast.success('项目已更新');
      } else {
        await api.createProject(values);
        toast.success('项目创建成功');
      }
      setCreateOpen(false);
      // 程序化关闭不触发 onOpenChange，这里必须同步清空，否则下次“新建项目”会带出旧编辑态
      setEditingProject(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleOpenEdit = (project: IProject) => {
    setEditingProject(project);
    setCreateOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteProject(deleteTarget.id);
      setDeleteTarget(null);
      toast.success('项目已删除');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // 逐个调用单删接口：某一项失败（如正在导入中）不影响其余项，最后汇总报数
  const handleBatchDelete = async () => {
    const ids = [...selection.selected];
    setBatchConfirmOpen(false);
    setBatchDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteProject(id);
      } catch {
        failed += 1;
      }
    }
    setBatchDeleting(false);
    selection.clear();
    await refresh();
    if (failed === 0) toast.success(`已删除 ${ids.length} 个项目`);
    else toast.warning(`已删除 ${ids.length - failed} 个项目，${failed} 个失败（可能正在导入或扫描中）`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">项目管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            创建并管理代码审查项目，上传源码 ZIP 后发起 opengrep 扫描
          </p>
        </div>
        <Button className="gap-1" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          新建项目
        </Button>
      </div>

      <BatchDeleteBar
        count={selection.count}
        label="项目"
        deleting={batchDeleting}
        onDelete={() => setBatchConfirmOpen(true)}
        onClear={selection.clear}
      />

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">项目列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 px-6 py-8">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <FolderOpen className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                暂无项目，点击右上角「新建项目」开始第一次代码审查
              </p>
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
                        aria-label="全选项目"
                      />
                    </TableHead>
                    <TableHead className="whitespace-nowrap">项目名称</TableHead>
                    <TableHead className="whitespace-nowrap">描述</TableHead>
                    <TableHead className="whitespace-nowrap">创建时间</TableHead>
                    <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="w-10">
                        <Checkbox
                          checked={selection.selected.has(project.id)}
                          onCheckedChange={() => selection.toggle(project.id)}
                          aria-label={`选择项目 ${project.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/projects/${project.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {project.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-[260px] truncate text-muted-foreground">
                          {project.description ?? '—'}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {formatDateTime(project.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => handleOpenEdit(project)}>
                              <Pencil className="size-4" />
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setDeleteTarget(project)}
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

      <NewProjectDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setEditingProject(null);
          }
        }}
        project={editingProject}
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
            <AlertDialogTitle>确认删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除项目「{deleteTarget?.name}」？该项目下的扫描记录将一并移除，此操作不可恢复。
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
        label="项目"
        count={selection.count}
        extra="项目下的扫描记录与源码快照将一并移除。"
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
