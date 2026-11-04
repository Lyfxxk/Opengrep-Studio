import type { IIssue } from '@/data/issues';
import { clearCurrentUser } from '@/lib/auth';
import { MOCK_ISSUES, mockIssuesForScan, mockIssueFingerprint } from '@/data/issues';
import { MOCK_CONFIGS, type IConfig } from '@/data/configs';
import { MOCK_PROJECTS, type IProject } from '@/data/projects';
import i18n from '@/i18n';
import type { ICodeSnippet } from '@/data/codesnippets';
import { MOCK_CODE_SNIPPETS } from '@/data/codesnippets';
import { MOCK_RULE_PACKS, type IRulePack } from '@/data/rulepacks';
import type { IRulePackCheckResult } from '@/data/rulepacks';
import type { IReviewRecord, IScanDiff, IRuleKnowledge } from '@/data/diffs';
import type { ITaintStep } from '@/data/issues';
import { MOCK_SCAN_RESULTS, type IScanResult } from '@/data/scanresults';
import { buildMockReport, type IReportData } from '@/data/reports';

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

function loadProjects(): IProject[] {
  return loadJson<IProject[]>(PROJECTS_KEY, [...MOCK_PROJECTS], 'project list');
}

function saveProjects(projects: IProject[]): void {
  saveJson(PROJECTS_KEY, projects, 'project list');
}

function loadScans(): IScanResult[] {
  return loadJson<IScanResult[]>(SCANS_KEY, [...MOCK_SCAN_RESULTS], 'scan records');
}

function saveScans(scans: IScanResult[]): void {
  saveJson(SCANS_KEY, scans, 'scan records');
}

function loadConfigs(): IConfig[] {
  return loadJson<IConfig[]>(CONFIGS_KEY, [...MOCK_CONFIGS], 'scan configs');
}

function saveConfigs(configs: IConfig[]): void {
  saveJson(CONFIGS_KEY, configs, 'scan configs');
}

function loadRulePacks(): IRulePack[] {
  return loadJson<IRulePack[]>(RULE_PACKS_KEY, [...MOCK_RULE_PACKS], 'rule packs');
}

function saveRulePacks(packs: IRulePack[]): void {
  saveJson(RULE_PACKS_KEY, packs, 'rule packs');
}

function loadReviews(): IReviewRecord[] {
  return loadJson<IReviewRecord[]>(REVIEWS_KEY, [], 'manual reviews');
}

function saveReviews(reviews: IReviewRecord[]): void {
  saveJson(REVIEWS_KEY, reviews, 'manual reviews');
}

function loadPackContents(): Record<string, string> {
  return loadJson<Record<string, string>>(PACK_CONTENTS_KEY, {}, 'rule pack contents');
}

function savePackContents(contents: Record<string, string>): void {
  saveJson(PACK_CONTENTS_KEY, contents, 'rule pack contents');
}

function productLang(): string {
  const lang = (i18n.resolvedLanguage ?? i18n.language).toLowerCase();
  if (lang.startsWith('zh-hant')) return 'zh-Hant';
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  return 'zh';
}

export const USE_MOCK =
  import.meta.env.VITE_USE_MOCK === 'true' || import.meta.env.VITE_USE_MOCK === '1';

interface ApiErrorShape {
  error?: { message?: string; code?: string; params?: Record<string, unknown> };
}

export function translateApiError(
  code: string | undefined,
  params: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  const t = i18n.t as (key: string, opts?: Record<string, unknown>) => string;
  const resolved = { ...params };
  if (typeof resolved.reasonCode === 'string') {
    resolved.reason = t(`apiErrors.${resolved.reasonCode}`, {
      ...((resolved.reasonParams as Record<string, unknown> | undefined) ?? {}),
      defaultValue: '',
    });
    delete resolved.reasonCode;
    delete resolved.reasonParams;
  }
  return t(`apiErrors.${code}`, { ...resolved, defaultValue: fallback });
}

const AUTH_REDIRECT_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/me']);

function redirectToLogin(): void {
  clearCurrentUser();
  window.location.assign('/login');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers:
      init?.body && !isFormData
        ? { 'Content-Type': 'application/json', ...init?.headers }
        : init?.headers,
  });
  if (!res.ok) {
    if (res.status === 401 && !AUTH_REDIRECT_EXEMPT_PATHS.has(path)) {
      redirectToLogin();
    }
    let message = i18n.t('api.requestFailed', { status: res.status });
    let code: string | undefined;
    let params: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as ApiErrorShape;
      message = body.error?.message ?? message;
      code = body.error?.code;
      params = body.error?.params;
    } catch {
    }
    throw new Error(translateApiError(code, params, message));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function uploadWithProgress(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<{ fileName: string; fileSize: number; fileCount: number; languageStats?: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.max(8, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({ fileName: '', fileSize: 0, fileCount: 0 });
        }
        return;
      }
      if (xhr.status === 401) {
        redirectToLogin();
      }
      let message = i18n.t('api.uploadFailed', { status: xhr.status });
      let code: string | undefined;
      let params: Record<string, unknown> | undefined;
      try {
        const body = JSON.parse(xhr.responseText) as ApiErrorShape;
        message = body.error?.message ?? message;
        code = body.error?.code;
        params = body.error?.params;
      } catch {
      }
      reject(new Error(translateApiError(code, params, message)));
    };
    xhr.onerror = () => reject(new Error(i18n.t('api.networkUploadFailed')));
    xhr.send(formData);
  });
}


type ProjectInput = {
  name: string;
  description: string;
};

export type UserRole = 'admin' | 'auditor' | 'viewer';

export interface SessionUser {
  username: string;
  role: UserRole;
}

export const authApi = {
  login(username: string, password: string): Promise<SessionUser> {
    return request<SessionUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout(): Promise<void> {
    return request<void>('/api/auth/logout', { method: 'POST' });
  },

  me(): Promise<SessionUser> {
    return request<SessionUser>('/api/auth/me');
  },
};

export interface UploadItem {
  file: File;
  relativePath?: string;
}

export interface ConfigFormValues {
  name: string;
  description?: string;
  rulePackIds: string[];
  excludes: string[];
  includes: string[];
  timeoutSeconds: number;
  jobs: number;
  maxTargetBytes: number;
}

export interface RuleLabMatch {
  ruleId: string;
  checkId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  severity: string;
  message: string;
  matchedLines?: string;
  taintFlow?: ITaintStep[];
}

export interface RuleLabRunResult {
  verdict: 'pass' | 'fail' | 'error';
  ruleIds: string[];
  language: string;
  durationMs: number;
  positive: { provided: boolean; matches: RuleLabMatch[] };
  negative: { provided: boolean; matches: RuleLabMatch[] };
  failures: Array<{ code: string; params?: Record<string, unknown>; message: string }>;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, unknown>;
  engineErrors: string[];
}

export interface HealthInfo {
  ok: boolean;
  platform?: string;
  arch?: string;
  engineVersion?: string;
  enginePinnedVersion?: string;
  engineManaged?: boolean;
  engineReady?: boolean;
  engineSource?: 'env' | 'bundled-dir' | 'path' | 'missing';
  engine?: string;
  engineHint?: string;
  engineHintCode?: string;
  engineHintParams?: Record<string, unknown>;
  engineHintMacos?: boolean;
}

export interface IEngineUpdateInfo {
  current?: string;
  pinned?: string;
  latest?: string;
  latestTag?: string;
  updateAvailable: boolean;
  canUpgrade: boolean;
  assetName?: string;
  releaseUrl?: string;
  publishedAt?: string;
  checkedAt: string;
  reason?: string;
  reasonCode?: string;
  reasonParams?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, unknown>;
}

export interface IEngineUpgradeState {
  state: 'idle' | 'running' | 'done' | 'error';
  phase?: 'downloading' | 'verifying' | 'installing';
  percent?: number;
  from?: string;
  to?: string;
  message?: string;
  messageCode?: string;
  messageParams?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

const MOCK_SCAN_DURATION_MS = 3000;

interface IDashboardProjectRisk {
  projectId: string;
  latestScanId?: string;
  total: number;
  critical: number;
  high: number;
}

export interface IDashboardRiskSummary {
  projects: IDashboardProjectRisk[];
  severityCounts: Record<IIssue['severity'], number>;
  topRules: Array<{ ruleId: string; severity: IIssue['severity']; count: number }>;
  pendingReview: number;
  total: number;
}

function mockScanIssueCount(): number {
  return MOCK_ISSUES.filter(
    (issue) => issue.scanId === '2' && issue.comparisonStatus !== 'fixed',
  ).length;
}

function materializeMockScans(): IScanResult[] {
  const scans = loadScans();
  const now = Date.now();
  let changed = false;
  const settled = scans.map((scan) => {
    if (scan.status !== 'scanning') return scan;
    if (now - new Date(scan.scannedAt).getTime() < MOCK_SCAN_DURATION_MS) return scan;
    changed = true;
    return {
      ...scan,
      status: 'completed' as const,
      issueCount: mockScanIssueCount(),
      finishedAt: new Date().toISOString(),
    };
  });
  if (changed) saveScans(settled);
  return settled;
}

function withMockReviews(issues: IIssue[], projectId?: string): IIssue[] {
  const reviews = loadReviews().filter((review) => !projectId || review.projectId === projectId);
  if (reviews.length === 0) return issues;
  const byFingerprint = new Map(reviews.map((review) => [review.fingerprint, review]));
  return issues.map((issue) => {
    const review = byFingerprint.get(mockIssueFingerprint(issue));
    if (!review || review.status === 'pending') return issue;
    return {
      ...issue,
      review: {
        status: review.status,
        ...(review.reason ? { reason: review.reason } : {}),
        ...(review.reviewer ? { reviewer: review.reviewer } : {}),
        updatedAt: review.updatedAt,
      },
    };
  });
}

function mockRiskSummary(): IDashboardRiskSummary {
  const latest = new Map<string, IScanResult>();
  for (const scan of materializeMockScans()) {
    if (scan.status !== 'completed') continue;
    const prev = latest.get(scan.projectId);
    if (
      !prev ||
      scan.scannedAt > prev.scannedAt ||
      (scan.scannedAt === prev.scannedAt && scan.id > prev.id)
    ) {
      latest.set(scan.projectId, scan);
    }
  }
  const severityCounts: Record<IIssue['severity'], number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const ruleCounts = new Map<string, { ruleId: string; severity: IIssue['severity']; count: number }>();
  const projects: IDashboardProjectRisk[] = [];
  let pendingReview = 0;
  let total = 0;
  for (const project of loadProjects()) {
    const latestScan = latest.get(project.id);
    const row: IDashboardProjectRisk = { projectId: project.id, total: 0, critical: 0, high: 0 };
    if (latestScan) row.latestScanId = latestScan.id;
    const issues = latestScan
      ? withMockReviews(mockIssuesForScan(latestScan.id), project.id).filter(
          (issue) => issue.comparisonStatus !== 'fixed',
        )
      : [];
    for (const issue of issues) {
      severityCounts[issue.severity] += 1;
      if (issue.severity === 'critical') row.critical += 1;
      if (issue.severity === 'high') row.high += 1;
      if (!issue.review) pendingReview += 1;
      const rule = ruleCounts.get(issue.ruleId);
      if (rule) rule.count += 1;
      else {
        ruleCounts.set(issue.ruleId, {
          ruleId: issue.ruleId,
          severity: issue.severity,
          count: 1,
        });
      }
    }
    row.total = issues.length;
    total += issues.length;
    projects.push(row);
  }
  const topRules = [...ruleCounts.values()]
    .sort(
      (a, b) =>
        b.count - a.count || a.ruleId.localeCompare(b.ruleId),
    )
    .slice(0, 6);
  return { projects, severityCounts, topRules, pendingReview, total };
}

function countMockRules(yamlText: string): number {
  return [...yamlText.matchAll(/^\s*-\s+id:\s*(\S+)/gm)].length || 1;
}

export const api = {
  isMockMode: USE_MOCK,

  listProjects(): Promise<IProject[]> {
    if (USE_MOCK) return Promise.resolve(loadProjects());
    return request<IProject[]>('/api/projects');
  },

  async createProject(input: ProjectInput): Promise<IProject> {
    if (USE_MOCK) {
      const project: IProject = {
        id: `p-${Date.now()}`,
        name: input.name,
        description: input.description || undefined,
        createdAt: new Date().toISOString(),
      };
      saveProjects([project, ...loadProjects()]);
      return project;
    }
    return request<IProject>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async updateProject(
    id: string,
    patch: {
      name?: string;
      description?: string;
      language?: string;
      baselineScanId?: string | null;
      configId?: string | null;
    },
  ): Promise<IProject> {
    if (USE_MOCK) {
      const next = loadProjects().map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              configId: patch.configId === null ? undefined : (patch.configId ?? item.configId),
              baselineScanId:
                patch.baselineScanId === null
                  ? undefined
                  : (patch.baselineScanId ?? item.baselineScanId),
            }
          : item,
      );
      const updated = next.find((item) => item.id === id);
      if (!updated) throw new Error(i18n.t('api.projectNotFound'));
      saveProjects(next);
      return updated;
    }
    return request<IProject>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async deleteProject(id: string): Promise<void> {
    if (USE_MOCK) {
      saveProjects(loadProjects().filter((item) => item.id !== id));
      saveScans(loadScans().filter((scan) => scan.projectId !== id));
      return;
    }
    await request<void>(`/api/projects/${id}`, { method: 'DELETE' });
  },

  uploadSource(
    projectId: string,
    items: UploadItem[],
    options?: { respectGitignore?: boolean; onProgress?: (percent: number) => void },
  ): Promise<{
    fileName: string;
    fileSize: number;
    fileCount: number;
    ignoredCount?: number;
    languageStats?: Record<string, number>;
  }> {
    if (USE_MOCK) {
      const totalSize = items.reduce((sum, item) => sum + item.file.size, 0);
      const fileName =
        items.length === 1 ? items[0].file.name : i18n.t('api.multiFileLabel', { count: items.length });
      return new Promise((resolve) => {
        let progress = 8;
        const timer = setInterval(() => {
          progress = Math.min(progress + 18, 96);
          options?.onProgress?.(progress);
        }, 250);
        setTimeout(() => {
          clearInterval(timer);
          options?.onProgress?.(100);
          resolve({ fileName, fileSize: totalSize, fileCount: items.length, ignoredCount: 0 });
        }, 2000);
      });
    }
    const formData = new FormData();
    formData.append('respectGitignore', String(options?.respectGitignore ?? true));
    const single = items.length === 1 && !items[0].relativePath ? items[0] : null;
    if (single) {
      formData.append('file', single.file);
    } else {
      for (const { file, relativePath } of items) {
        formData.append('files', file, file.name);
        formData.append('paths', relativePath || file.name);
      }
    }
    return uploadWithProgress(`/api/projects/${projectId}/source`, formData, options?.onProgress);
  },

  cloneSource(projectId: string, url: string, ref?: string): Promise<{
    url: string;
    ref: string;
    fileCount: number;
    languageStats?: Record<string, number>;
  }> {
    if (USE_MOCK) {
      return new Promise((resolve) =>
        setTimeout(() => resolve({ url, ref: ref || 'HEAD', fileCount: 36 }), 1800),
      );
    }
    return request(`/api/projects/${projectId}/clone`, {
      method: 'POST',
      body: JSON.stringify({ url, ref: ref || undefined }),
    });
  },

  startScan(
    projectId: string,
    options?: { baselineScanId?: string | null },
  ): Promise<IScanResult> {
    if (USE_MOCK) {
      const record: IScanResult = {
        id: `scan-${Date.now()}`,
        projectId,
        status: 'scanning',
        issueCount: 0,
        scannedAt: new Date().toISOString(),
        baselineScanId: options?.baselineScanId ?? undefined,
      };
      saveScans([record, ...loadScans()]);
      return Promise.resolve(record);
    }
    return request<IScanResult>(`/api/projects/${projectId}/scans`, {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    });
  },

  listScans(projectId: string): Promise<IScanResult[]> {
    if (USE_MOCK) {
      return Promise.resolve(
        materializeMockScans().filter((scan) => scan.projectId === projectId),
      );
    }
    return request<IScanResult[]>(`/api/projects/${projectId}/scans`);
  },

  getScan(scanId: string): Promise<IScanResult> {
    if (USE_MOCK) {
      const scan = materializeMockScans().find((item) => item.id === scanId);
      if (!scan) {
        return Promise.reject(new Error(i18n.t('api.scanNotFound')));
      }
      return Promise.resolve(scan);
    }
    return request<IScanResult>(`/api/scans/${scanId}`);
  },

  listIssues(scanId: string): Promise<IIssue[]> {
    if (USE_MOCK) {
      const scan = materializeMockScans().find((item) => item.id === scanId);
      return Promise.resolve(withMockReviews(mockIssuesForScan(scanId), scan?.projectId));
    }
    return request<IIssue[]>(`/api/scans/${scanId}/issues`);
  },

  async getSnippet(scanId: string, issue: IIssue): Promise<ICodeSnippet> {
    if (USE_MOCK) {
      const snippet = MOCK_CODE_SNIPPETS.find((item) => item.issueId === issue.id);
      if (snippet) return snippet;
      return {
        issueId: issue.id,
        filePath: issue.filePath,
        startLine: issue.startLine,
        endLine: issue.endLine,
        content: i18n.t('api.demoSnippetPlaceholder'),
        highlightedLines: [issue.startLine],
      };
    }
    const params = new URLSearchParams({
      path: issue.filePath,
      start: String(issue.startLine),
      end: String(issue.endLine),
      issueId: issue.id,
    });
    return request<ICodeSnippet>(`/api/scans/${scanId}/snippet?${params.toString()}`);
  },


  getScanReport(scanId: string): Promise<IReportData> {
    if (USE_MOCK) {
      const scan = materializeMockScans().find((item) => item.id === scanId);
      if (!scan || scan.status !== 'completed') {
        return Promise.reject(new Error(i18n.t('api.scanNotCompleted')));
      }
      const project = loadProjects().find((item) => item.id === scan.projectId);
      return Promise.resolve(buildMockReport(scan, project?.name ?? i18n.t('api.demoProjectName')));
    }
    return request<IReportData>(`/api/scans/${scanId}/report`);
  },

  scanReportHtmlUrl(scanId: string): string {
    return `/api/scans/${scanId}/report?format=html&lang=${productLang()}`;
  },


  ruleLabRun(input: {
    yaml: string;
    positive: string;
    negative: string;
  }): Promise<RuleLabRunResult> {
    if (USE_MOCK) {
      return new Promise((resolve) =>
        setTimeout(() => {
          const hit = /eval\s*\(/.test(input.positive);
          resolve({
            verdict: input.positive.trim() && hit ? 'pass' : 'fail',
            ruleIds: ['demo-eval'],
            language: 'javascript',
            durationMs: 420,
            positive: {
              provided: Boolean(input.positive.trim()),
              matches: hit
                ? [{
                    ruleId: 'demo-eval',
                    checkId: 'demo-eval',
                    startLine: 2,
                    endLine: 2,
                    startCol: 10,
                    severity: 'WARNING',
                    message: i18n.t('api.demoHitMessage'),
                    matchedLines: input.positive.split(/\r?\n/)[1] ?? '',
                  }]
                : [],
            },
            negative: { provided: Boolean(input.negative.trim()), matches: [] },
            failures:
              input.positive.trim() && !hit
                ? [{ code: 'lab.positiveNoMatch', message: i18n.t('api.failPositiveMiss') }]
                : [],
            engineErrors: [],
          });
        }, 900),
      );
    }
    return request<RuleLabRunResult>('/api/rulelab/run', {
      method: 'POST',
      body: JSON.stringify({
        yaml: input.yaml,
        samples: { positive: input.positive, negative: input.negative },
      }),
    });
  },

  listConfigs(): Promise<IConfig[]> {
    if (USE_MOCK) return Promise.resolve(loadConfigs());
    return request<IConfig[]>('/api/configs');
  },

  createConfig(values: ConfigFormValues): Promise<IConfig> {
    if (USE_MOCK) {
      const config: IConfig = {
        id: `cfg-${Date.now()}`,
        ...values,
        createdAt: new Date().toISOString(),
      };
      saveConfigs([...loadConfigs(), config]);
      return Promise.resolve(config);
    }
    return request<IConfig>('/api/configs', {
      method: 'POST',
      body: JSON.stringify(values),
    });
  },

  async updateConfig(id: string, values: ConfigFormValues): Promise<void> {
    if (USE_MOCK) {
      const configs = loadConfigs();
      const index = configs.findIndex((config) => config.id === id);
      if (index === -1) throw new Error(i18n.t('api.configNotFound'));
      configs[index] = { ...configs[index], ...values };
      saveConfigs(configs);
      return;
    }
    await request<void>(`/api/configs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(values),
    });
  },

  async deleteConfig(id: string): Promise<void> {
    if (USE_MOCK) {
      saveConfigs(loadConfigs().filter((config) => config.id !== id));
      return;
    }
    await request<void>(`/api/configs/${id}`, { method: 'DELETE' });
  },

  listRulePacks(): Promise<IRulePack[]> {
    if (USE_MOCK) return Promise.resolve(loadRulePacks());
    return request<IRulePack[]>('/api/rulepacks');
  },

  async toggleRulePack(id: string, enabled: boolean): Promise<void> {
    if (USE_MOCK) {
      const packs = loadRulePacks();
      const target = packs.find((pack) => pack.id === id);
      if (!target) throw new Error(i18n.t('api.rulePackNotFound'));
      target.enabled = enabled;
      saveRulePacks(packs);
      return;
    }
    await request<void>(`/api/rulepacks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  },

  async uploadRulePack(file: File, name: string, language: string): Promise<IRulePack> {
    if (USE_MOCK) {
      const content = await file.text();
      const pack: IRulePack = {
        id: `rp-${Date.now()}`,
        name,
        language,
        builtin: false,
        enabled: true,
        ruleCount: countMockRules(content),
        createdAt: new Date().toISOString(),
      };
      saveRulePacks([pack, ...loadRulePacks()]);
      const contents = loadPackContents();
      contents[pack.id] = content;
      savePackContents(contents);
      return pack;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);
    formData.append('language', language);
    return request<IRulePack>('/api/rulepacks/upload', {
      method: 'POST',
      body: formData,
    });
  },

  createRulePack(
    name: string,
    language: string,
    content: string,
    samples?: { positive: string; negative: string },
  ): Promise<IRulePack> {
    if (USE_MOCK) {
      const hasSamples = Boolean(samples?.positive.trim() || samples?.negative.trim());
      const pack: IRulePack = {
        id: `rp-${Date.now()}`,
        name,
        language,
        builtin: false,
        enabled: true,
        ruleCount: countMockRules(content),
        createdAt: new Date().toISOString(),
        ...(hasSamples
          ? {
              version: '1.0.0',
              isDir: true,
              sampleCount: [samples?.positive, samples?.negative].filter((text) => text?.trim()).length,
              manifest: { name, version: '1.0.0', license: 'UNLICENSED' },
            }
          : {}),
      };
      saveRulePacks([pack, ...loadRulePacks()]);
      const contents = loadPackContents();
      contents[pack.id] = content;
      savePackContents(contents);
      return Promise.resolve(pack);
    }
    return request<IRulePack>('/api/rulepacks', {
      method: 'POST',
      body: JSON.stringify({
        name,
        language,
        content,
        ...(samples && (samples.positive.trim() || samples.negative.trim())
          ? { samples: { positive: samples.positive, negative: samples.negative } }
          : {}),
      }),
    });
  },

  getRulePackContent(
    id: string,
  ): Promise<{ id: string; name: string; language: string; content: string }> {
    if (USE_MOCK) {
      const pack = loadRulePacks().find((item) => item.id === id);
      if (!pack) return Promise.reject(new Error(i18n.t('api.rulePackNotFound')));
      const content =
        loadPackContents()[id] ??
        `${i18n.t('api.demoSarifHeader')}\nrules:\n  - id: ${pack.id}-rule-1\n    languages: [${pack.language.toLowerCase()}]\n    message: ${i18n.t('api.demoSarifRuleMessage')}\n    severity: WARNING\n    pattern: eval(...)\n`;
      return Promise.resolve({ id, name: pack.name, language: pack.language, content });
    }
    return request(`/api/rulepacks/${id}/content`);
  },

  updateRulePackContent(id: string, content: string): Promise<IRulePack> {
    if (USE_MOCK) {
      const packs = loadRulePacks();
      const target = packs.find((pack) => pack.id === id);
      if (!target) return Promise.reject(new Error(i18n.t('api.rulePackNotFound')));
      if (target.builtin) return Promise.reject(new Error(i18n.t('api.builtinNotEditable')));
      target.ruleCount = countMockRules(content);
      saveRulePacks(packs);
      const contents = loadPackContents();
      contents[id] = content;
      savePackContents(contents);
      return Promise.resolve(target);
    }
    return request(`/api/rulepacks/${id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  async countConfigsUsingRulePack(rulePackId: string): Promise<number> {
    const configs = await api.listConfigs();
    return configs.filter((config) => config.rulePackIds.includes(rulePackId)).length;
  },

  async deleteRulePack(id: string): Promise<void> {
    if (USE_MOCK) {
      const packs = loadRulePacks();
      const target = packs.find((pack) => pack.id === id);
      if (!target) throw new Error(i18n.t('api.rulePackNotFound'));
      if (target.builtin) throw new Error(i18n.t('api.builtinNotDeletable'));
      saveRulePacks(packs.filter((pack) => pack.id !== id));
      const contents = loadPackContents();
      delete contents[id];
      savePackContents(contents);
      return;
    }
    await request<void>(`/api/rulepacks/${id}`, { method: 'DELETE' });
  },

  importRulePack(file: File): Promise<IRulePack & {
    message?: string;
    messageCode?: string;
    messageParams?: Record<string, unknown>;
  }> {
    if (USE_MOCK) {
      const name = file.name.replace(/\.zip$/i, '');
      const pack: IRulePack & { message?: string } = {
        id: `rp-${Date.now()}`,
        name,
        language: 'Other',
        builtin: false,
        enabled: true,
        ruleCount: 1,
        createdAt: new Date().toISOString(),
        isDir: true,
        sampleCount: 0,
        manifest: { name, version: '0.1.0' },
        message: i18n.t('api.importRegistered'),
      };
      saveRulePacks([pack, ...loadRulePacks()]);
      return new Promise((resolve) => setTimeout(() => resolve(pack), 800));
    }
    const formData = new FormData();
    formData.append('file', file);
    return request('/api/rulepacks/import', {
      method: 'POST',
      body: formData,
    });
  },

  exportRulePackUrl(id: string): string {
    return `/api/rulepacks/${id}/export`;
  },

  checkRulePack(id: string): Promise<IRulePackCheckResult> {
    if (USE_MOCK) {
      const pack = loadRulePacks().find((item) => item.id === id);
      if (!pack) return Promise.reject(new Error(i18n.t('api.rulePackNotFound')));
      const startedAt = Date.now();
      return new Promise((resolve) =>
        setTimeout(() => {
          const unverified = pack.ruleCount;
          resolve({
            tier: 'basic',
            items: Array.from({ length: Math.min(unverified, 3) }, (_, index) => ({
              ruleId: `${pack.id}-rule-${index + 1}`,
              ruleFile: `rules/rule.yaml`,
              positiveCount: 0,
              negativeCount: 0,
              verdict: 'unverified' as const,
              detail: i18n.t('api.checkDemoDetail'),
            })),
            durationMs: Date.now() - startedAt,
            summary: {
              tier: 'basic' as const,
              passed: 0,
              failed: 0,
              errors: 0,
              unverified,
              checkedAt: new Date().toISOString(),
            },
          });
        }, 1200),
      );
    }
    return request(`/api/rulepacks/${id}/check`, { method: 'POST' });
  },

  setReview(
    projectId: string,
    fingerprint: string,
    input: { status: 'confirmed' | 'false_positive' | 'accepted'; reason?: string; reviewer?: string },
  ): Promise<IReviewRecord> {
    if (USE_MOCK) {
      const record: IReviewRecord = {
        projectId,
        fingerprint,
        status: input.status,
        ...(input.reason ? { reason: input.reason } : {}),
        reviewer: input.reviewer || 'admin',
        updatedAt: new Date().toISOString(),
      };
      const rest = loadReviews().filter(
        (review) => !(review.projectId === projectId && review.fingerprint === fingerprint),
      );
      saveReviews([...rest, record]);
      return Promise.resolve(record);
    }
    return request(`/api/projects/${projectId}/reviews`, {
      method: 'PUT',
      body: JSON.stringify({ fingerprint, ...input }),
    });
  },

  async clearReview(projectId: string, fingerprint: string): Promise<void> {
    if (USE_MOCK) {
      saveReviews(
        loadReviews().filter(
          (review) => !(review.projectId === projectId && review.fingerprint === fingerprint),
        ),
      );
      return;
    }
    await request<void>(`/api/projects/${projectId}/reviews/${encodeURIComponent(fingerprint)}`, {
      method: 'DELETE',
    });
  },

  listAllScans(): Promise<IScanResult[]> {
    if (USE_MOCK) return Promise.resolve(materializeMockScans());
    return request('/api/scans');
  },

  getDashboardRiskSummary(): Promise<IDashboardRiskSummary> {
    if (USE_MOCK) return Promise.resolve(mockRiskSummary());
    return request<IDashboardRiskSummary>('/api/dashboard/risk-summary');
  },

  async deleteScan(id: string): Promise<void> {
    if (USE_MOCK) {
      saveScans(loadScans().filter((scan) => scan.id !== id));
      return;
    }
    await request<void>(`/api/scans/${id}`, { method: 'DELETE' });
  },

  async cancelScan(id: string): Promise<void> {
    if (USE_MOCK) {
      saveScans(
        loadScans().map((scan) =>
          scan.id === id && scan.status === 'scanning'
            ? {
                ...scan,
                status: 'failed' as const,
                finishedAt: new Date().toISOString(),
                message: '已被手动取消',
                errorCode: 'scan.cancelled',
              }
            : scan,
        ),
      );
      return;
    }
    await request<void>(`/api/scans/${id}/cancel`, { method: 'POST' });
  },

  getHealth(): Promise<HealthInfo> {
    if (USE_MOCK) {
      return Promise.resolve({
        ok: false,
        engine: 'MISSING',
        engineReady: false,
        engineHint: i18n.t('api.demoEngineHint'),
      });
    }
    return request('/api/health');
  },

  checkEngineUpdate(force = false): Promise<IEngineUpdateInfo> {
    if (USE_MOCK) {
      return Promise.resolve({
        updateAvailable: false,
        canUpgrade: false,
        checkedAt: new Date().toISOString(),
        reason: i18n.t('api.demoUpdateReason'),
      });
    }
    return request(`/api/engine/update${force ? '?refresh=1' : ''}`);
  },

  engineUpgradeState(): Promise<IEngineUpgradeState> {
    return request('/api/engine/upgrade');
  },

  startEngineUpgrade(): Promise<IEngineUpgradeState> {
    if (USE_MOCK) {
      return Promise.reject(new Error(i18n.t('api.demoUpgradeUnsupported')));
    }
    return request('/api/engine/upgrade', { method: 'POST' });
  },

  getScanDiff(scanId: string, againstId: string): Promise<IScanDiff> {
    if (USE_MOCK) {
      const current = mockIssuesForScan(scanId);
      const against = mockIssuesForScan(againstId);
      const fp = (issue: IIssue) => mockIssueFingerprint(issue);
      const againstFps = new Set(against.map(fp));
      const currentFps = new Set(current.map(fp));
      const toSummary = (issue: IIssue) => ({
        ruleId: issue.ruleId,
        severity: issue.severity,
        filePath: issue.filePath,
        startLine: issue.startLine,
        message: issue.message,
      });
      const diff: IScanDiff = {
        scanId,
        against: {
          id: againstId,
          projectId: '',
          projectName: i18n.t('api.demoProjectName'),
          scannedAt: '',
        },
        issueDiff: {
          new: {
            count: current.filter((issue) => !againstFps.has(fp(issue))).length,
            items: current.filter((issue) => !againstFps.has(fp(issue))).slice(0, 200).map(toSummary),
          },
          fixed: {
            count: against.filter((issue) => !currentFps.has(fp(issue))).length,
            items: against.filter((issue) => !currentFps.has(fp(issue))).slice(0, 200).map(toSummary),
          },
          remaining: {
            count: current.filter((issue) => againstFps.has(fp(issue))).length,
            items: current.filter((issue) => againstFps.has(fp(issue))).slice(0, 200).map(toSummary),
          },
        },
        fileDiff: {
          filesA: 128,
          filesB: 128,
          added: [],
          removed: [],
          modified: [
            {
              path: 'src/api/user.ts',
              addedLines: 6,
              removedLines: 2,
              diffable: true,
            },
          ],
        },
      };
      return Promise.resolve(diff);
    }
    const params = new URLSearchParams({ against: againstId });
    return request(`/api/scans/${scanId}/diff?${params.toString()}`);
  },

  getRuleKnowledge(ruleId: string): Promise<IRuleKnowledge> {
    if (USE_MOCK) {
      const hits = MOCK_ISSUES.filter((issue) => issue.ruleId === ruleId);
      return Promise.resolve({
        ruleId,
        found: false,
        cwe: [],
        owasp: [],
        stats: { total: hits.length, projects: hits.length > 0 ? 1 : 0 },
      });
    }
    return request(
      `/api/rules/knowledge/${encodeURIComponent(ruleId)}?lang=${encodeURIComponent(productLang())}`,
    );
  },

  scanSarifUrl(scanId: string): string {
    return `/api/scans/${scanId}/sarif`;
  },

  importSarif(projectId: string, file: File, baselineScanId?: string): Promise<IScanResult> {
    const formData = new FormData();
    formData.append('file', file);
    if (baselineScanId) formData.append('baselineScanId', baselineScanId);
    return request<IScanResult>(`/api/projects/${projectId}/sarif`, {
      method: 'POST',
      body: formData,
    });
  },

  scanManifestUrl(scanId: string): string {
    return `/api/scans/${scanId}/manifest?lang=${productLang()}`;
  },
};
