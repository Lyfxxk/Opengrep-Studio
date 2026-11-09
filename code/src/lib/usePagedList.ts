import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { IProject } from '@/data/projects';
import type { IScanResult } from '@/data/scanresults';

export type ScanWithProject = IScanResult & { projectName?: string };

export function attachProjectNames(
  scans: IScanResult[],
  projects: IProject[],
): ScanWithProject[] {
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));
  return [...scans]
    .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime())
    .map((scan) => ({ ...scan, projectName: nameOf.get(scan.projectId) ?? scan.projectId }));
}

export function filterScans(
  scans: ScanWithProject[],
  projectId: string,
  keyword: string,
): ScanWithProject[] {
  const trimmed = keyword.trim().toLowerCase();
  return scans.filter((scan) => {
    if (projectId !== 'all' && scan.projectId !== projectId) return false;
    if (trimmed === '') return true;
    return (
      scan.id.toLowerCase().includes(trimmed) ||
      (scan.projectName ?? '').toLowerCase().includes(trimmed)
    );
  });
}

export function useScanRows(options?: { completedOnly?: boolean }) {
  const completedOnly = options?.completedOnly ?? false;
  const [scans, setScans] = useState<ScanWithProject[] | null>(null);
  const [projects, setProjects] = useState<IProject[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const requestSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    try {
      const [allScans, allProjects] = await Promise.all([api.listAllScans(), api.listProjects()]);
      if (requestSeqRef.current !== seq) return;
      setProjects(allProjects);
      setLoadFailed(false);
      setScans(
        attachProjectNames(
          completedOnly ? allScans.filter((scan) => scan.status === 'completed') : allScans,
          allProjects,
        ),
      );
    } catch (error) {
      if (requestSeqRef.current !== seq) return;
      toast.error(error instanceof Error ? error.message : String(error));
      setLoadFailed(true);
    }
  }, [completedOnly]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { scans, projects, loadFailed, reload };
}

export function usePagedList<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  useEffect(() => {
    setPage(safePage);
  }, [safePage]);
  const start = (safePage - 1) * pageSize;
  return {
    page: safePage,
    setPage,
    pageCount,
    slice: items.slice(start, start + pageSize),
  };
}

export function useRowSelection(ids: readonly string[]) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const present = useMemo(() => new Set(ids), [ids]);
  const selected = useMemo(
    () => new Set([...selectedIds].filter((id) => present.has(id))),
    [selectedIds, present],
  );

  const allSelected = ids.length > 0 && selected.size === ids.length;
  return {
    selected,
    count: selected.size,
    allSelected,
    someSelected: selected.size > 0 && !allSelected,
    toggle(id: string): void {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll(): void {
      setSelectedIds(allSelected ? new Set() : new Set(present));
    },
    clear(): void {
      setSelectedIds(new Set());
    },
  };
}
