import type { IProject } from '@/data/projects';
import type { IScanResult } from '@/data/scanresults';

/** 扫描记录附项目名（扫描中心 / 报告中心 / 对比对话框共用形态） */
export type ScanWithProject = IScanResult & { projectName?: string };

/** 合并全量扫描与项目名：按扫描时间倒序，项目已删除时回退展示项目 ID */
export function attachProjectNames(
  scans: IScanResult[],
  projects: IProject[],
): ScanWithProject[] {
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));
  return [...scans]
    .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime())
    .map((scan) => ({ ...scan, projectName: nameOf.get(scan.projectId) ?? scan.projectId }));
}
