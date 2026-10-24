import type { IIssue } from '@/data/issues';
import { MOCK_ISSUES } from '@/data/issues';
import type { IConfig } from '@/data/configs';
import type { IProject } from '@/data/projects';
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
} from '@/lib/storage';

// 演示模式开关：只认显式的 'true' / '1'，避免 VITE_USE_MOCK=false 被 Boolean('false') 误判为开
const USE_MOCK = ['true', '1'].includes(
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_USE_MOCK ?? '',
);

interface ApiErrorShape {
  error?: { message?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData 由浏览器自动生成 multipart 边界，手动设置 Content-Type 会破坏上传
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const res = await fetch(path, {
    headers: init?.body && !isFormData ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as ApiErrorShape;
      message = body.error?.message ?? message;
    } catch {
    }
    throw new Error(message);
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
      let message = `上传失败（HTTP ${xhr.status}）`;
      try {
        message = (JSON.parse(xhr.responseText) as ApiErrorShape).error?.message ?? message;
      } catch {
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
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

/** /api/health 响应（引擎解析结果；引擎缺失时 ok=false 且附指引） */
export interface HealthInfo {
  ok: boolean;
  engineVersion?: string;
  engineSource?: string;
  engine?: string;
  hint?: string;
}

/** mock 扫描从发起到完成的时长；读取时按 scannedAt 惰性收敛，刷新页面/丢失定时器也不会永久卡在 scanning */
const MOCK_SCAN_DURATION_MS = 3000;

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
      issueCount: 6 + Math.floor(Math.random() * 9),
      finishedAt: new Date().toISOString(),
    };
  });
  if (changed) saveScans(settled);
  return settled;
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
      if (!updated) throw new Error('项目不存在或已被删除');
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
        items.length === 1 ? items[0].file.name : `${items.length} 个文件`;
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
        return Promise.reject(new Error('扫描记录不存在'));
      }
      return Promise.resolve(scan);
    }
    return request<IScanResult>(`/api/scans/${scanId}`);
  },

  listIssues(scanId: string): Promise<IIssue[]> {
    if (USE_MOCK) {
      const matched = MOCK_ISSUES.filter((issue) => issue.scanId === scanId);
      return Promise.resolve(matched.length > 0 ? matched : MOCK_ISSUES.filter((i) => i.scanId === '2'));
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
        content: '// 演示模式：暂无该问题的片段数据',
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
        return Promise.reject(new Error('仅已完成的扫描可生成测试报告'));
      }
      const project = loadProjects().find((item) => item.id === scan.projectId);
      return Promise.resolve(buildMockReport(scan, project?.name ?? '演示项目'));
    }
    return request<IReportData>(`/api/scans/${scanId}/report`);
  },

  /** 自包含 HTML 报告的下载地址（含严重/高危问题的代码片段） */
  scanReportHtmlUrl(scanId: string): string {
    return `/api/scans/${scanId}/report?format=html`;
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
                    message: '演示命中：使用 eval 动态执行代码',
                    matchedLines: input.positive.split(/\r?\n/)[1] ?? '',
                  }]
                : [],
            },
            negative: { provided: Boolean(input.negative.trim()), matches: [] },
            failReasons:
              input.positive.trim() && !hit
                ? ['正例未命中：期望至少 1 处命中，实际 0 处']
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
    return request<IConfig[]>('/api/configs');
  },

  createConfig(values: ConfigFormValues): Promise<IConfig> {
    return request<IConfig>('/api/configs', {
      method: 'POST',
      body: JSON.stringify(values),
    });
  },

  async updateConfig(id: string, values: ConfigFormValues): Promise<void> {
    await request<void>(`/api/configs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(values),
    });
  },

  async deleteConfig(id: string): Promise<void> {
    await request<void>(`/api/configs/${id}`, { method: 'DELETE' });
  },

  listRulePacks(): Promise<IRulePack[]> {
    return request<IRulePack[]>('/api/rulepacks');
  },

  async toggleRulePack(id: string, enabled: boolean): Promise<void> {
    await request<void>(`/api/rulepacks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  },

  uploadRulePack(file: File, name: string, language: string): Promise<IRulePack> {
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
    return request(`/api/rulepacks/${id}/content`);
  },

  updateRulePackContent(id: string, content: string): Promise<IRulePack> {
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
    await request<void>(`/api/rulepacks/${id}`, { method: 'DELETE' });
  },

  /** 导入可移植规则包 zip（含 pack.yaml 清单与可选样本），也接受单个 YAML 的压缩包 */
  importRulePack(file: File): Promise<IRulePack & { message?: string }> {
    const formData = new FormData();
    formData.append('file', file);
    return request(`/api/rulepacks/import`, {
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
    return request(`/api/rulepacks/${id}/check`, { method: 'POST' });
  },

  /** 人工复核：以 (项目, fingerprint) 为键设置结论，跨扫描继承 */
  setReview(
    projectId: string,
    fingerprint: string,
    input: { status: 'confirmed' | 'false_positive' | 'accepted'; reason?: string; reviewer?: string },
  ): Promise<IReviewRecord> {
    return request(`/api/projects/${projectId}/reviews`, {
      method: 'PUT',
      body: JSON.stringify({ fingerprint, ...input }),
    });
  },

  /** 清除复核结论（回到待复核） */
  async clearReview(projectId: string, fingerprint: string): Promise<void> {
    await request<void>(`/api/projects/${projectId}/reviews/${encodeURIComponent(fingerprint)}`, {
      method: 'DELETE',
    });
  },

  /** 全量扫描列表（跨项目对比候选池 / 扫描中心） */
  listAllScans(): Promise<IScanResult[]> {
    if (USE_MOCK) return Promise.resolve(materializeMockScans());
    return request('/api/scans');
  },

  /** 健康检查（引擎版本与解析来源）；演示模式下无后端，直接返回不可用 */
  getHealth(): Promise<HealthInfo> {
    if (USE_MOCK) return Promise.resolve({ ok: false });
    return request('/api/health');
  },

  /** 双快照对比：问题级 + 文件级 */
  getScanDiff(scanId: string, againstId: string): Promise<IScanDiff> {
    const params = new URLSearchParams({ against: againstId });
    return request(`/api/scans/${scanId}/diff?${params.toString()}`);
  },

  /** 中文规则知识库条目 */
  getRuleKnowledge(ruleId: string): Promise<IRuleKnowledge> {
    return request(`/api/rules/knowledge/${encodeURIComponent(ruleId)}`);
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
    return `/api/scans/${scanId}/manifest`;
  },
};
