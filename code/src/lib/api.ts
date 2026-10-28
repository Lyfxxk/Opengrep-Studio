import type { IIssue } from '@/data/issues';
import { MOCK_ISSUES, mockIssuesForScan, mockIssueFingerprint } from '@/data/issues';
import type { IConfig } from '@/data/configs';
import type { IProject } from '@/data/projects';
import i18n from '@/i18n';
import type { ICodeSnippet } from '@/data/codesnippets';
import { MOCK_CODE_SNIPPETS } from '@/data/codesnippets';
import type { IRulePack } from '@/data/rulepacks';
import type { IRulePackCheckResult } from '@/data/rulepacks';
import type { IReviewRecord, IScanDiff, IRuleKnowledge } from '@/data/diffs';
import type { ITaintStep } from '@/data/issues';
import type { IScanResult } from '@/data/scanresults';
import { buildMockReport, type IReportData } from '@/data/reports';
import {
  loadProjects,
  loadScans,
  saveProjects,
  saveScans,
  loadConfigs,
  saveConfigs,
  loadRulePacks,
  saveRulePacks,
  loadReviews,
  saveReviews,
  loadPackContents,
  savePackContents,
} from '@/lib/storage';

/** 当前界面语言 → 服务端产物语言：zh / zh-Hant / en 三种，其余语言回落简体 */
function productLang(): string {
  const lang = (i18n.resolvedLanguage ?? i18n.language).toLowerCase();
  if (lang.startsWith('zh-hant')) return 'zh-Hant';
  if (lang.startsWith('en')) return 'en';
  return 'zh';
}

// 演示模式开关：只认显式的 'true' / '1'，避免 VITE_USE_MOCK=false 被 Boolean('false') 误判为开
export const USE_MOCK = ['true', '1'].includes(
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_USE_MOCK ?? '',
);

interface ApiErrorShape {
  error?: { message?: string; code?: string; params?: Record<string, unknown> };
}

/**
 * 后端错误码 → 当前语言文案：code 是前后端契约（键见 i18n 资源 apiErrors 组）。
 * 键由后端契约动态决定、无法枚举进 t() 的类型系统，故对 t 做局部宽化；
 * defaultValue 兜底保证前后端版本错位时退回后端原文而不是显示裸键名。
 */
function translateApiError(
  code: string | undefined,
  params: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  const t = i18n.t as (key: string, opts?: Record<string, unknown>) => string;
  return t(`apiErrors.${code}`, { ...params, defaultValue: fallback });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData 由浏览器自动生成 multipart 边界，手动设置 Content-Type 会破坏上传
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers:
      init?.body && !isFormData
        ? { 'Content-Type': 'application/json', ...init?.headers }
        : init?.headers,
  });
  if (!res.ok) {
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

/** 上传条目：压缩包为单条（无 relativePath）；文件夹/多文件时 relativePath 为目录内相对路径 */
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

/** 规则实验室的单处命中 */
export interface RuleLabMatch {
  ruleId: string;
  checkId: string;
  startLine: number;
  endLine: number;
  startCol: number;
  severity: string;
  message: string;
  matchedLines?: string;
  /** taint 规则命中的污点传播链 */
  taintFlow?: ITaintStep[];
}

/** 规则实验室运行结果：pass=正例命中且反例无误报；fail=漏报/误报；error=规则或引擎出错 */
export interface RuleLabRunResult {
  verdict: 'pass' | 'fail' | 'error';
  ruleIds: string[];
  language: string;
  durationMs: number;
  positive: { provided: boolean; matches: RuleLabMatch[] };
  negative: { provided: boolean; matches: RuleLabMatch[] };
  failReasons: string[];
  error?: string;
  engineErrors: string[];
}

/** /api/health 响应；ok 恒为 true 仅表示服务存活，引擎可用性看 engine 是否为 'MISSING' */
export interface HealthInfo {
  ok: boolean;
  platform?: string;
  arch?: string;
  /** 实际探测到的引擎版本（引擎缺失时为 undefined） */
  engineVersion?: string;
  /** 清单钉住的版本（engines.json，或已升级后的 installed.json） */
  enginePinnedVersion?: string;
  /** 引擎是否由本应用安装并管理（env / PATH 来源为 false，不支持一键升级） */
  engineManaged?: boolean;
  engineSource?: string;
  /** 引擎来源的中文标注 */
  engineSourceLabel?: string;
  /** 解析后的引擎路径；未找到时为 'MISSING'，并附 engineHint 修复指引 */
  engine?: string;
  engineHint?: string;
}

/** 引擎更新检查结果（GET /api/engine/update） */
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
  /** 不可升级的人话原因 */
  reason?: string;
  /** 上游不可达等网络异常说明 */
  error?: string;
}

/** 一键升级进度（POST/GET /api/engine/upgrade） */
export interface IEngineUpgradeState {
  state: 'idle' | 'running' | 'done' | 'error';
  phase?: 'downloading' | 'verifying' | 'installing';
  percent?: number;
  from?: string;
  to?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** mock 扫描从发起到完成的时长；读取时按 scannedAt 惰性收敛，刷新页面/丢失定时器也不会永久卡在 scanning */
const MOCK_SCAN_DURATION_MS = 3000;

/** mock 扫描完成时的问题数：与 listIssues 的回退样本口径一致（不含已修复项） */
const MOCK_SCAN_ISSUE_COUNT = MOCK_ISSUES.filter(
  (issue) => issue.scanId === '2' && issue.comparisonStatus !== 'fixed',
).length;

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
      issueCount: MOCK_SCAN_ISSUE_COUNT,
      finishedAt: new Date().toISOString(),
    };
  });
  if (changed) saveScans(settled);
  return settled;
}

/** 演示模式的复核结论合并进问题列表（与服务端 issues 接口口径一致：待复核不返回 review 字段） */
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

/** 演示模式粗算 YAML 规则条数（统计顶格 `- id:` 条目；仅用于展示，不做校验） */
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
      // null → undefined 归一，保持 localStorage 里的 IProject 形状（可选字段不能存 null）
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
      // 与服务端删除语义一致：级联清理该项目下的扫描记录
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
    /** 按 .gitignore 忽略规则剪枝掉的文件数（关闭过滤时为 0） */
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
      // 单个压缩包走原有 file 字段
      formData.append('file', single.file);
    } else {
      for (const { file, relativePath } of items) {
        formData.append('files', file, file.name);
        formData.append('paths', relativePath || file.name);
      }
    }
    return uploadWithProgress(`/api/projects/${projectId}/source`, formData, options?.onProgress);
  },

  /** 从 Git 仓库 URL 浅克隆源码（服务端执行 git clone --depth 1），与上传源码等效 */
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

  /** 自包含 HTML 报告的下载地址（含严重/高危问题的代码片段）：带上当前语言，报告正文与文件名同步本地化 */
  scanReportHtmlUrl(scanId: string): string {
    return `/api/scans/${scanId}/report?format=html&lang=${productLang()}`;
  },


  /** 规则实验室：提交规则 YAML + 正/反例样本，返回三态判定与命中明细 */
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
            failReasons:
              input.positive.trim() && !hit
                ? [i18n.t('api.failPositiveMiss')]
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

  /** 在线创建规则包；带 samples 时落成可移植目录包（样本随包分发，可一键质量检查） */
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
    const configs = await this.listConfigs();
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

  /** 导入可移植规则包 zip（含 pack.yaml 清单与可选样本），也接受单个 YAML 的压缩包 */
  importRulePack(file: File): Promise<IRulePack & { message?: string }> {
    if (USE_MOCK) {
      // 演示模式不解析 zip，按文件名登记一个 basic 档包
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

  /** 导出可移植规则包 zip 的下载地址 */
  exportRulePackUrl(id: string): string {
    return `/api/rulepacks/${id}/export`;
  },

  /** 质量检查：逐规则跑正反例样本（复用规则实验室引擎链路） */
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

  /** 人工复核：以 (项目, fingerprint) 为键设置结论，跨扫描继承 */
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

  /** 清除复核结论（回到待复核） */
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

  /** 全量扫描列表（跨项目对比候选池 / 扫描中心） */
  listAllScans(): Promise<IScanResult[]> {
    if (USE_MOCK) return Promise.resolve(materializeMockScans());
    return request('/api/scans');
  },

  /** 删除单条扫描（问题明细与源码快照一并移除；进行中的扫描后端返回 409） */
  async deleteScan(id: string): Promise<void> {
    if (USE_MOCK) {
      saveScans(loadScans().filter((scan) => scan.id !== id));
      return;
    }
    await request<void>(`/api/scans/${id}`, { method: 'DELETE' });
  },

  /** 健康检查（引擎版本与解析来源）；演示模式下无后端，直接标记引擎缺失 */
  getHealth(): Promise<HealthInfo> {
    if (USE_MOCK) {
      return Promise.resolve({
        ok: false,
        engine: 'MISSING',
        engineHint: i18n.t('api.demoEngineHint'),
      });
    }
    return request('/api/health');
  },

  /** 检查引擎更新（force=true 跳过服务端 10 分钟缓存） */
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

  /** 一键升级进度（升级在后台跑，靠轮询拿百分比） */
  engineUpgradeState(): Promise<IEngineUpgradeState> {
    return request('/api/engine/upgrade');
  },

  /** 发起一键升级；失败（扫描中 / 已是最新 / 上游不可达）会抛出可读错误 */
  startEngineUpgrade(): Promise<IEngineUpgradeState> {
    if (USE_MOCK) {
      return Promise.reject(new Error(i18n.t('api.demoUpgradeUnsupported')));
    }
    return request('/api/engine/upgrade', { method: 'POST' });
  },

  /** 双快照对比：问题级 + 文件级 */
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

  /** 规则知识库条目：服务端按 lang 返回简体或繁体说明 */
  getRuleKnowledge(ruleId: string, lang: string): Promise<IRuleKnowledge> {
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
      `/api/rules/knowledge/${encodeURIComponent(ruleId)}?lang=${encodeURIComponent(lang)}`,
    );
  },

  /** SARIF 2.1.0 导出下载地址（GitHub Code Scanning / DefectDojo 等工具链可消费） */
  scanSarifUrl(scanId: string): string {
    return `/api/scans/${scanId}/sarif`;
  },

  /** 导入外部 SARIF 结果：生成本项目的一条"已完成"扫描，可设基线参与对比 */
  importSarif(projectId: string, file: File, baselineScanId?: string): Promise<IScanResult> {
    const formData = new FormData();
    formData.append('file', file);
    if (baselineScanId) formData.append('baselineScanId', baselineScanId);
    return request<IScanResult>(`/api/projects/${projectId}/sarif`, {
      method: 'POST',
      body: formData,
    });
  },

  /** 扫描可复现清单（源码哈希 + 引擎命令行 + 规则哈希 + 参数快照） */
  scanManifestUrl(scanId: string): string {
    return `/api/scans/${scanId}/manifest?lang=${productLang()}`;
  },
};
