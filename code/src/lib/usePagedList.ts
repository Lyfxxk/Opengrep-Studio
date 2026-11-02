import { useEffect, useMemo, useState } from 'react';
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
