import { MOCK_PROJECTS, type IProject } from '@/data/projects';
import { MOCK_SCAN_RESULTS, type IScanResult } from '@/data/scanresults';
import { MOCK_CONFIGS, type IConfig } from '@/data/configs';
import { MOCK_RULE_PACKS, type IRulePack } from '@/data/rulepacks';
import type { IReviewRecord } from '@/data/diffs';

// 演示模式（VITE_USE_MOCK）的 localStorage 持久化：结构与各领域类型一一对应，
// 缺失/损坏时回退到内置种子数据，保证无后端也能走通完整工作流。

const PROJECTS_KEY = '__global_opengrep_projects';
const SCANS_KEY = '__global_opengrep_scans';
const CONFIGS_KEY = '__global_opengrep_configs';
const RULE_PACKS_KEY = '__global_opengrep_rulepacks';
const REVIEWS_KEY = '__global_opengrep_reviews';
const PACK_CONTENTS_KEY = '__global_opengrep_pack_contents';

function loadJson<T>(key: string, fallback: T, label: string): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      return JSON.parse(raw) as T;
    }
  } catch (error) {
    console.error(`读取${label}缓存失败，回退到内置示例数据:`, String(error));
  }
  return fallback;
}

function saveJson(key: string, value: unknown, label: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`保存${label}失败:`, String(error));
  }
}

export function loadProjects(): IProject[] {
  return loadJson<IProject[]>(PROJECTS_KEY, [...MOCK_PROJECTS], '项目列表');
}

export function saveProjects(projects: IProject[]): void {
  saveJson(PROJECTS_KEY, projects, '项目列表');
}

export function loadScans(): IScanResult[] {
  return loadJson<IScanResult[]>(SCANS_KEY, [...MOCK_SCAN_RESULTS], '扫描记录');
}

export function saveScans(scans: IScanResult[]): void {
  saveJson(SCANS_KEY, scans, '扫描记录');
}

export function loadConfigs(): IConfig[] {
  return loadJson<IConfig[]>(CONFIGS_KEY, [...MOCK_CONFIGS], '扫描配置');
}

export function saveConfigs(configs: IConfig[]): void {
  saveJson(CONFIGS_KEY, configs, '扫描配置');
}

export function loadRulePacks(): IRulePack[] {
  return loadJson<IRulePack[]>(RULE_PACKS_KEY, [...MOCK_RULE_PACKS], '规则包');
}

export function saveRulePacks(packs: IRulePack[]): void {
  saveJson(RULE_PACKS_KEY, packs, '规则包');
}

export function loadReviews(): IReviewRecord[] {
  return loadJson<IReviewRecord[]>(REVIEWS_KEY, [], '人工复核');
}

export function saveReviews(reviews: IReviewRecord[]): void {
  saveJson(REVIEWS_KEY, reviews, '人工复核');
}

/** 自建规则包的 YAML 内容（packId → 文本），供演示模式的查看/编辑回显 */
export function loadPackContents(): Record<string, string> {
  return loadJson<Record<string, string>>(PACK_CONTENTS_KEY, {}, '规则包内容');
}

export function savePackContents(contents: Record<string, string>): void {
  saveJson(PACK_CONTENTS_KEY, contents, '规则包内容');
}
