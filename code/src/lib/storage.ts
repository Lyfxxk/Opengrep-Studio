import { MOCK_PROJECTS, type IProject } from '@/data/projects';
import { MOCK_SCAN_RESULTS, type IScanResult } from '@/data/scanresults';

const PROJECTS_KEY = '__global_opengrep_projects';
const SCANS_KEY = '__global_opengrep_scans';

export function loadProjects(): IProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      return JSON.parse(raw) as IProject[];
    }
  } catch (error) {
    console.error('读取项目列表缓存失败，回退到内置示例数据:', String(error));
  }
  return [...MOCK_PROJECTS];
}

export function saveProjects(projects: IProject[]): void {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch (error) {
    console.error('保存项目列表失败:', String(error));
  }
}

export function loadScans(): IScanResult[] {
  try {
    const raw = localStorage.getItem(SCANS_KEY);
    if (raw) {
      return JSON.parse(raw) as IScanResult[];
    }
  } catch (error) {
    console.error('读取扫描记录缓存失败，回退到内置示例数据:', String(error));
  }
  return [...MOCK_SCAN_RESULTS];
}

export function saveScans(scans: IScanResult[]): void {
  try {
    localStorage.setItem(SCANS_KEY, JSON.stringify(scans));
  } catch (error) {
    console.error('保存扫描记录失败:', String(error));
  }
}
