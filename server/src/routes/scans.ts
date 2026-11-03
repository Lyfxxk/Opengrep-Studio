import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config, pendingSourceDir, scanSnapshotRoot, scanSourceDir } from '../config.js';
import { copyDirectory, isPathWithin } from '../archive.js';
import { HttpError } from '../errors.js';
import {
  deleteScan,
  getConfig,
  getIssue,
  getProject,
  getRulePack,
  getScan,
  getRiskSummary,
  insertScan,
  isActiveIssue,
  listAllScans,
  listIssues,
  listReviews,
  listScans,
  replaceIssues,
  updateProject,
  updateScan,
  type IssueRow,
  type Project,
  type ScanConfig,
  type ScanRecord,
} from '../db.js';
import { ensureFallbackScanConfig } from '../fallback-config.js';
import { listRuleMessages } from '../knowledge.js';
import { engineAvailable, engineInstallHint, engineUpgradeRunning, getEngineVersion } from '../engine.js';
import { diffSnapshots } from '../snapshot-diff.js';
import { packRuleFiles } from '../rulepacks.js';
import { buildSarifReport, parseSarifImport } from '../sarif.js';
import { buildReportData, renderReportHtml, sanitizeCommand } from '../report.js';
import { applyBaselineComparison, enqueueScan, requestScanCancel, type ScanPlan } from '../scan-runner.js';
import {
  asyncHandler,
  decodeUploadFileName,
  limit400,
  memoryFileUpload,
  parseProductLang,
  requireProject,
  requireValidBaseline,
} from './shared.js';
import {
  isProjectImporting,
  markProjectImporting,
  unmarkProjectImporting,
} from './projects.js';

export const scanRoutes = Router();

const MAX_SARIF_BYTES = 20 * 1024 * 1024;

function resolveScanConfig(project: Project): ScanConfig {
  const bound = project.configId ? getConfig(project.configId) : undefined;
  if (bound) return bound;
  const fallbackConfig = ensureFallbackScanConfig();
  if (!fallbackConfig) {
    throw new HttpError(
      400,
      '没有已启用的内置规则包，无法创建兜底配置；请先在配置管理创建配置并在项目详情页绑定',
      { code: 'srv.noEnabledBuiltinPacks' },
    );
  }
  updateProject(project.id, { configId: fallbackConfig.id });
  project.configId = fallbackConfig.id;
  return fallbackConfig;
}

function buildConfigPlan(project: Project): ScanPlan {
  const scanConfig = resolveScanConfig(project);
  const configFiles: string[] = [];
  const rulepacks: Array<{ id: string; name: string }> = [];
  const filePacks: Record<string, { id: string; name: string }> = {};
  for (const packId of scanConfig.rulePackIds) {
    const pack = getRulePack(packId);
    if (!pack || !pack.enabled) continue;
    const files = packRuleFiles(pack);
    if (files.length > 0) {
      const ref = { id: pack.id, name: pack.name };
      rulepacks.push(ref);
      for (const file of files) {
        configFiles.push(file);
        filePacks[file] = ref;
      }
    }
  }
  if (configFiles.length === 0) {
    throw new HttpError(400, '配置未勾选任何可用且启用的规则包，请检查配置管理', {
      code: 'srv.configNoPacks',
    });
  }
  return {
    rulesLabel: scanConfig.name,
    configFiles,
    rulepacks,
    filePacks,
    timeoutSeconds: scanConfig.timeoutSeconds,
    jobs: scanConfig.jobs,
    maxTargetBytes: scanConfig.maxTargetBytes,
    excludes: scanConfig.excludes,
    includes: scanConfig.includes,
  };
}

function newScanId(projectName: string): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'proj';
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `scan-${slug}-${time}-${Math.random().toString(36).slice(2, 6)}`;
}

function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7E]+/g, '_');
}

function requireScan(id: string): ScanRecord {
  const scan = getScan(id);
  if (!scan) throw new HttpError(404, '扫描记录不存在或已被删除', { code: 'srv.scanNotFound' });
  return scan;
}

function toScanSummary(scan: ScanRecord): Omit<ScanRecord, 'srcHash' | 'commandLine' | 'configSnapshot'> {
  const { srcHash: _srcHash, commandLine: _commandLine, configSnapshot: _configSnapshot, ...rest } = scan;
  return rest;
}

async function resolveScanEngineVersion(scan: ScanRecord): Promise<string | undefined> {
  if (scan.engineVersion) return scan.engineVersion;
  if (!scan.commandLine) return undefined;
  return getEngineVersion();
}

scanRoutes.post('/api/projects/:id/scans', asyncHandler(async (req, res) => {
  if (engineUpgradeRunning()) {
    throw new HttpError(409, '引擎升级进行中，请升级完成后再发起扫描', {
      code: 'srv.scanUpgradeBusy',
    });
  }
  const project = requireProject(req.params.id);
  if (isProjectImporting(project.id)) {
    throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再试', {
      code: 'srv.projectImportBusy',
    });
  }
  const pendingDir = pendingSourceDir(project.id);
  if (!fs.existsSync(pendingDir)) {
    throw new HttpError(400, '请先上传源码或克隆仓库再发起扫描', { code: 'srv.noSourceToScan' });
  }
  if (!engineAvailable()) {
    throw new HttpError(400, engineInstallHint(), { code: 'srv.engineMissing' });
  }

  const plan = buildConfigPlan(project);

  let baselineScanId: string | undefined;
  const baselineParam = req.body?.baselineScanId;
  if (baselineParam !== undefined && baselineParam !== null && baselineParam !== '') {
    baselineScanId = requireValidBaseline(project.id, baselineParam);
  } else if (project.baselineScanId) {
    const fallback = getScan(project.baselineScanId);
    if (fallback && fallback.projectId === project.id && fallback.status === 'completed') {
      baselineScanId = project.baselineScanId;
    } else {
      updateProject(project.id, { baselineScanId: null });
    }
  }

  const scan: ScanRecord = {
    id: newScanId(project.name),
    projectId: project.id,
    status: 'scanning',
    issueCount: 0,
    scannedAt: new Date().toISOString(),
    baselineScanId,
    rules: plan.rulesLabel,
    rulepacks: plan.rulepacks,
    fileCount: 0,
  };

  const scanDir = scanSourceDir(project.id, scan.id);
  fs.mkdirSync(path.dirname(scanDir), { recursive: true });
  markProjectImporting(project.id);
  try {
    insertScan(scan);
    await copyDirectory(pendingDir, scanDir);
  } catch (error) {
    fs.rmSync(scanSnapshotRoot(project.id, scan.id), { recursive: true, force: true });
    deleteScan(scan.id);
    throw error;
  } finally {
    unmarkProjectImporting(project.id);
  }
  enqueueScan(scan.id, plan);
  res.status(201).json(scan);
}));

scanRoutes.get('/api/projects/:id/scans', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  res.json(listScans(req.params.id).map(toScanSummary));
}));

scanRoutes.get('/api/scans', asyncHandler(async (_req, res) => {
  res.json(listAllScans().map(toScanSummary));
}));

scanRoutes.get('/api/dashboard/risk-summary', asyncHandler(async (_req, res) => {
  res.json(getRiskSummary());
}));

scanRoutes.get('/api/scans/:scanId', asyncHandler(async (req, res) => {
  res.json(requireScan(req.params.scanId));
}));

scanRoutes.delete('/api/scans/:scanId', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status === 'scanning') {
    throw new HttpError(409, '扫描进行中，请等扫描完成或失败后再删除', { code: 'srv.scanBusy' });
  }
  deleteScan(scan.id);
  try {
    fs.rmSync(scanSnapshotRoot(scan.projectId, scan.id), { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[scans] 扫描 ${scan.id} 快照清理失败，可手动删除 ${scanSnapshotRoot(scan.projectId, scan.id)}：` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  res.status(204).end();
}));

scanRoutes.post('/api/scans/:scanId/cancel', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status !== 'scanning') {
    throw new HttpError(409, '扫描已结束，无需取消', { code: 'srv.scanNotRunning' });
  }
  if (requestScanCancel(scan.id)) {
    res.json({ status: 'cancelling' });
    return;
  }
  updateScan(scan.id, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    message: '已被手动取消',
    errorCode: 'scan.cancelled',
    queuedAt: null,
  });
  res.json({ status: 'failed' });
}));

scanRoutes.get('/api/scans/:scanId/issues', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  const issues = listIssues(scan.id);
  const reviews = new Map(listReviews(scan.projectId).map((review) => [review.fingerprint, review]));
  res.json(
    issues.map(({ matchedLines: _ml, dataflowTrace, ...issue }) => {
      let taintFlow: unknown;
      try {
        taintFlow = dataflowTrace ? JSON.parse(dataflowTrace) : undefined;
      } catch {
        taintFlow = undefined;
      }
      const review = reviews.get(issue.fingerprint);
      return {
        ...issue,
        ...(taintFlow ? { taintFlow } : {}),
        ...(review && review.status !== 'pending'
          ? {
              review: {
                status: review.status,
                ...(review.reason ? { reason: review.reason } : {}),
                ...(review.reviewer ? { reviewer: review.reviewer } : {}),
                updatedAt: review.updatedAt,
              },
            }
          : {}),
      };
    }),
  );
}));

scanRoutes.get('/api/scans/:scanId/snippet', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  const filePath = String(req.query.path ?? '');
  const startLine = Number(req.query.start ?? 0);
  const endLine = Number(req.query.end ?? 0);
  const issueId = req.query.issueId ? String(req.query.issueId) : undefined;
  if (
    !filePath ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new HttpError(400, '需要 path、start、end 查询参数（start ≥ 1 且 end ≥ start）', {
      code: 'srv.snippetParamsInvalid',
    });
  }

  const context = config.snippetContextLines;
  const srcRoot = path.resolve(scanSourceDir(scan.projectId, scan.id));
  const full = path.resolve(srcRoot, filePath);
  if (full !== srcRoot && !isPathWithin(srcRoot, full)) {
    throw new HttpError(400, '非法的文件路径', { code: 'srv.snippetPathInvalid' });
  }

  let content: string | undefined;
  let from = Math.max(1, startLine - context);
  let to = endLine + context;
  let source: 'file' | 'archive' = 'file';
  let lines: string[] | undefined;
  try {
    const stat = fs.statSync(full);
    if (stat.isFile() && stat.size <= config.maxSnippetFileBytes) {
      lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    }
  } catch {
  }

  if (lines && startLine > lines.length) {
    throw new HttpError(400, `start=${startLine} 超出文件行数（文件共 ${lines.length} 行）`, {
      code: 'srv.snippetStartOutOfRange',
      params: { startLine, fileLines: lines.length },
    });
  }

  if (lines) {
    to = Math.min(lines.length, to);
    content = lines.slice(from - 1, to).join('\n');
  }

  if (content === undefined) {
    const issue: IssueRow | undefined = issueId ? getIssue(issueId) : undefined;
    if (!issue || issue.scanId !== scan.id || issue.matchedLines === undefined) {
      throw new HttpError(404, '源码文件不存在且没有可用的片段缓存', {
        code: 'srv.snippetNotFound',
      });
    }
    content = issue.matchedLines;
    from = issue.startLine;
    to = issue.endLine;
    source = 'archive';
  }

  const highlightedLines: number[] = [];
  for (let line = Math.max(startLine, from); line <= Math.min(endLine, to); line += 1) {
    highlightedLines.push(line);
  }

  res.json({
    issueId,
    filePath,
    startLine: from,
    endLine: to,
    content,
    highlightedLines,
    source,
  });
}));

scanRoutes.get('/api/scans/:scanId/report', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status !== 'completed') {
    throw new HttpError(400, '仅已完成的扫描可生成测试报告', { code: 'srv.scanNotCompleted' });
  }
  const project = getProject(scan.projectId);
  if (!project) {
    throw new HttpError(404, '扫描所属项目不存在或已被删除', { code: 'srv.projectNotFound' });
  }
  const issues = listIssues(scan.id);
  const engineVersion = await resolveScanEngineVersion(scan);
  const data = buildReportData(scan, project, issues, engineVersion, listReviews(scan.projectId));

  const format = String(req.query.format ?? 'json');
  if (format === 'html') {
    const includeSnippets = req.query.detail !== 'summary';
    const lang = parseProductLang(req.query.lang);
    const messages = lang === 'en' ? undefined : listRuleMessages(lang);
    const html = renderReportHtml(data, issues, { includeSnippets }, lang, messages);
    const prefix =
      lang === 'zh-Hant'
        ? '測試報告'
        : lang === 'en'
          ? 'test-report'
          : lang === 'ja'
            ? 'テストレポート'
            : lang === 'ko'
              ? '테스트 보고서'
              : '测试报告';
    const fileName = `${prefix}-${project.name}-${scan.id}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-${asciiFilename(scan.id)}.html"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(html);
    return;
  }
  res.json(data);
}));

scanRoutes.get('/api/scans/:scanId/sarif', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status !== 'completed') {
    throw new HttpError(400, '仅已完成的扫描可导出 SARIF', { code: 'srv.sarifNotCompleted' });
  }
  const issues = listIssues(scan.id);
  const engineVersion = await resolveScanEngineVersion(scan);
  const sarif = buildSarifReport(scan, issues, engineVersion);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="sarif-${asciiFilename(scan.id)}.json"; filename*=UTF-8''${encodeURIComponent(`SARIF-${scan.id}.json`)}`,
  );
  res.json(sarif);
}));

const importSarifUpload = memoryFileUpload(MAX_SARIF_BYTES, {
  pattern: /\.(sarif|json)$/i,
  message: '仅支持 .sarif / .json 文件',
  code: 'srv.sarifOnly',
});

scanRoutes.post(
  '/api/projects/:id/sarif',
  limit400(importSarifUpload.single('file'), MAX_SARIF_BYTES),
  asyncHandler(async (req, res) => {
    const project = requireProject(req.params.id);
    if (!req.file) {
      throw new HttpError(400, '请通过 multipart 表单上传 file 字段（.sarif / .json）', {
        code: 'srv.fileRequired',
      });
    }

    let baselineScanId: string | undefined;
    const baselineParam = req.body?.baselineScanId;
    if (baselineParam !== undefined && baselineParam !== null && baselineParam !== '') {
      baselineScanId = requireValidBaseline(project.id, baselineParam);
    }

    const { toolName, issues } = parseSarifImport(req.file.buffer.toString('utf8'));

    const scan: ScanRecord = {
      id: newScanId(project.name),
      projectId: project.id,
      status: 'completed',
      issueCount: 0,
      scannedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      baselineScanId,
      importSource: 'sarif',
      ...(toolName ? { toolName } : {}),
      fileCount: 0,
    };
    for (const issue of issues) issue.scanId = scan.id;
    applyBaselineComparison(issues, scan.id, baselineScanId);
    scan.issueCount = issues.filter(isActiveIssue).length;

    insertScan(scan);
    try {
      replaceIssues(scan.id, issues);
    } catch (error) {
      deleteScan(scan.id);
      throw error;
    }
    console.log(
      `[sarif-import] 项目 ${project.id} 导入 ${decodeUploadFileName(req.file.originalname)}（${toolName}）：` +
        `${scan.issueCount} 个问题`,
    );
    res.status(201).json(scan);
  }),
);

scanRoutes.get('/api/scans/:scanId/manifest', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  const project = getProject(scan.projectId);
  const engineVersion = await resolveScanEngineVersion(scan);
  const lang = parseProductLang(req.query.lang);
  res.json({
    scanId: scan.id,
    projectId: scan.projectId,
    projectName: project?.name ?? null,
    status: scan.status,
    scannedAt: scan.scannedAt,
    finishedAt: scan.finishedAt ?? null,
    engine: {
      name: 'opengrep',
      version: engineVersion ?? null,
      binary: path.basename(config.opengrepBin),
    },
    source: {
      algorithm:
        lang === 'zh-Hant'
          ? 'sha256（按相對路徑排序，對 路徑 + \\0 + 檔案內容 + \\0 序列計算）'
          : lang === 'en'
            ? 'sha256 (paths sorted, then hash the path + \\0 + file content + \\0 sequence)'
            : 'sha256（按相对路径排序，对 路径 + \\0 + 文件内容 + \\0 序列计算）',
      sha256: scan.srcHash ?? null,
      fileCount: scan.fileCount,
    },
    commandLine: scan.commandLine ? sanitizeCommand(scan.commandLine) : null,
    config: scan.configSnapshot ?? null,
    baselineScanId: scan.baselineScanId ?? null,
  });
}));


scanRoutes.get('/api/scans/:scanId/diff', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status !== 'completed') {
    throw new HttpError(400, '仅已完成的扫描可参与对比', { code: 'srv.diffNotCompleted' });
  }
  const againstId = String(req.query.against ?? '');
  if (!againstId || againstId === scan.id) {
    throw new HttpError(400, '请提供要对比的另一次扫描（against 参数，且不能是自身）', {
      code: 'srv.againstInvalid',
    });
  }
  const against = getScan(againstId);
  if (!against || against.status !== 'completed') {
    throw new HttpError(404, '对比目标扫描不存在或未完成', { code: 'srv.againstNotFound' });
  }
  const srcDir = scanSourceDir(scan.projectId, scan.id);
  const againstDir = scanSourceDir(against.projectId, against.id);
  if (!fs.existsSync(srcDir) || !fs.existsSync(againstDir)) {
    throw new HttpError(
      400,
      '对比所需的源码快照已被清理，无法做文件级对比（问题级对比不受影响）',
      { code: 'srv.snapshotMissing' },
    );
  }
  const againstProject = getProject(against.projectId);
  const fileDiff = await diffSnapshots(againstDir, srcDir);

  const currentMap = new Map(
    listIssues(scan.id)
      .filter((issue) => issue.comparisonStatus !== 'fixed')
      .map((issue) => [issue.fingerprint, issue]),
  );
  const againstMap = new Map(
    listIssues(against.id)
      .filter((issue) => issue.comparisonStatus !== 'fixed')
      .map((issue) => [issue.fingerprint, issue]),
  );
  const ISSUE_LIST_CAP = 200;
  const toSummary = (issue: IssueRow) => ({
    ruleId: issue.ruleId,
    severity: issue.severity,
    filePath: issue.filePath,
    startLine: issue.startLine,
    message: issue.message,
  });
  const buildDiffList = (rows: IssueRow[]) => ({
    count: rows.length,
    items: rows.slice(0, ISSUE_LIST_CAP).map(toSummary),
  });
  const newIssues = [...currentMap.values()].filter((issue) => !againstMap.has(issue.fingerprint));
  const fixedIssues = [...againstMap.values()].filter((issue) => !currentMap.has(issue.fingerprint));
  const remainingIssues = [...currentMap.values()].filter((issue) => againstMap.has(issue.fingerprint));

  res.json({
    scanId: scan.id,
    against: {
      id: against.id,
      projectId: against.projectId,
      projectName: againstProject?.name ?? against.projectId,
      scannedAt: against.scannedAt,
    },
    issueDiff: {
      new: buildDiffList(newIssues),
      fixed: buildDiffList(fixedIssues),
      remaining: buildDiffList(remainingIssues),
    },
    fileDiff: {
      filesA: fileDiff.filesA,
      filesB: fileDiff.filesB,
      added: fileDiff.added,
      removed: fileDiff.removed,
      modified: fileDiff.modified,
    },
    engine: {
      current: scan.engineVersion ?? null,
      against: against.engineVersion ?? null,
      mismatch: Boolean(
        scan.engineVersion && against.engineVersion && scan.engineVersion !== against.engineVersion,
      ),
    },
  });
}));
