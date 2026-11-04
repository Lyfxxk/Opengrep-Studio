import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
import { FolderOpen, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import Pagination from '@/components/Pagination';
import { Input } from '@/components/ui/input';
import { LIST_PAGE_SIZE } from '@/data/constants';
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
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import BatchDeleteBar, { BatchDeleteConfirm } from '@/components/BatchDeleteBar';
import { usePagedList, useRowSelection } from '@/lib/usePagedList';
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
import { hasRole } from '@/lib/auth';
import { Skeleton } from '@/components/ui/skeleton';
import NewProjectDialog from './NewProjectDialog';

export default function ProjectsPage() {
  const { t } = useTranslation();
  const canEdit = hasRole('auditor');
  const canDelete = hasRole('admin');
  const showActions = canEdit || canDelete;
  const [projects, setProjects] = useState<IProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<IProject | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IProject | null>(null);
  const [keyword, setKeyword] = useState('');
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const filteredProjects = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    if (trimmed === '') return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(trimmed) ||
        (project.description ?? '').toLowerCase().includes(trimmed),
    );
  }, [projects, keyword]);

  const selection = useRowSelection(filteredProjects.map((project) => project.id));

  const { page: safePage, setPage, pageCount, slice: pagedProjects } = usePagedList(
    filteredProjects,
    LIST_PAGE_SIZE,
  );

  const refresh = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (error) {
      toast.error(t('projects.loadFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      } else {
        await api.createProject(values);
      }
      setCreateOpen(false);
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
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

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
    if (failed > 0)
      toast.warning(
        t('projects.batchPartial', { count: ids.length - failed, failed }),
      );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{t('nav.projects')}</h1>
        {canEdit && (
          <Button className="gap-1" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t('projects.newProject')}
          </Button>
        )}
      </div>

      {(projects.length > 0) && (
        <div className="flex items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-[320px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t('projects.searchPlaceholder')}
              className="pl-9"
            />
          </div>
        </div>
      )}

      {canDelete && (
        <BatchDeleteBar
          count={selection.count}
          entity="project"
          deleting={batchDeleting}
          onDelete={() => setBatchConfirmOpen(true)}
          onClear={selection.clear}
        />
      )}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 px-6 py-8">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <FolderOpen className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {projects.length === 0 ? t('projects.empty') : t('projects.searchEmpty')}
              </p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {canDelete && (
                      <TableHead className="w-10">
                        <Checkbox
                          checked={selection.allSelected ? true : selection.someSelected ? 'indeterminate' : false}
                          onCheckedChange={() => selection.toggleAll()}
                          aria-label={t('projects.selectAllAria')}
                        />
                      </TableHead>
                    )}
                    <TableHead className="whitespace-nowrap">{t('projects.colName')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('projects.colDescription')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('projects.colCreatedAt')}</TableHead>
                    {showActions && (
                      <TableHead className="whitespace-nowrap text-right">{t('common.actions')}</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedProjects.map((project) => (
                    <TableRow key={project.id}>
                      {canDelete && (
                        <TableCell className="w-10">
                          <Checkbox
                            checked={selection.selected.has(project.id)}
                            onCheckedChange={() => selection.toggle(project.id)}
                            aria-label={t('projects.rowSelectAria', { name: project.name })}
                          />
                        </TableCell>
                      )}
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
                      {showActions && (
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-8">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {canEdit && (
                                <DropdownMenuItem onSelect={() => handleOpenEdit(project)}>
                                  <Pencil className="size-4" />
                                  {t('common.edit')}
                                </DropdownMenuItem>
                              )}
                              {canDelete && (
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={() => setDeleteTarget(project)}
                                >
                                  <Trash2 className="size-4" />
                                  {t('common.delete')}
                                </DropdownMenuItem>
                              )}
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

      <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />

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
            <AlertDialogTitle>{t('projects.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects.deleteDesc', { name: deleteTarget?.name ?? '' })}
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
        entity="project"
        count={selection.count}
        extra={t('projects.batchExtra')}
        onOpenChange={setBatchConfirmOpen}
        onConfirm={handleBatchDelete}
      />
    </div>
  );
}
