import { useEffect, useState } from 'react';
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
