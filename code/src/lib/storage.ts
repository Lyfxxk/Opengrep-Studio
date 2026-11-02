import { MOCK_PROJECTS, type IProject } from '@/data/projects';
import { MOCK_SCAN_RESULTS, type IScanResult } from '@/data/scanresults';
import { MOCK_CONFIGS, type IConfig } from '@/data/configs';
import { MOCK_RULE_PACKS, type IRulePack } from '@/data/rulepacks';
import type { IReviewRecord } from '@/data/diffs';

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
    console.error(`Failed to load ${label} cache, falling back to built-in sample data:`, String(error));
  }
  return fallback;
}

function saveJson(key: string, value: unknown, label: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Failed to save ${label}:`, String(error));
  }
}

export function loadProjects(): IProject[] {
  return loadJson<IProject[]>(PROJECTS_KEY, [...MOCK_PROJECTS], 'project list');
}

export function saveProjects(projects: IProject[]): void {
  saveJson(PROJECTS_KEY, projects, 'project list');
}

export function loadScans(): IScanResult[] {
  return loadJson<IScanResult[]>(SCANS_KEY, [...MOCK_SCAN_RESULTS], 'scan records');
}

export function saveScans(scans: IScanResult[]): void {
  saveJson(SCANS_KEY, scans, 'scan records');
}

export function loadConfigs(): IConfig[] {
  return loadJson<IConfig[]>(CONFIGS_KEY, [...MOCK_CONFIGS], 'scan configs');
}

export function saveConfigs(configs: IConfig[]): void {
  saveJson(CONFIGS_KEY, configs, 'scan configs');
}

export function loadRulePacks(): IRulePack[] {
  return loadJson<IRulePack[]>(RULE_PACKS_KEY, [...MOCK_RULE_PACKS], 'rule packs');
}

export function saveRulePacks(packs: IRulePack[]): void {
  saveJson(RULE_PACKS_KEY, packs, 'rule packs');
}

export function loadReviews(): IReviewRecord[] {
  return loadJson<IReviewRecord[]>(REVIEWS_KEY, [], 'manual reviews');
}

export function saveReviews(reviews: IReviewRecord[]): void {
  saveJson(REVIEWS_KEY, reviews, 'manual reviews');
}

export function loadPackContents(): Record<string, string> {
  return loadJson<Record<string, string>>(PACK_CONTENTS_KEY, {}, 'rule pack contents');
}

export function savePackContents(contents: Record<string, string>): void {
  saveJson(PACK_CONTENTS_KEY, contents, 'rule pack contents');
}
