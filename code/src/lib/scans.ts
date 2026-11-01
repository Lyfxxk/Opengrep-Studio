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
