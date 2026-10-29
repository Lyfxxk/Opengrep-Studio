import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
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
  insertConfig,
  insertScan,
  isActiveIssue,
  listAllScans,
  listConfigs,
  listIssues,
  listReviews,
  listRulePacks,
  listScans,
  replaceIssues,
  updateProject,
  updateScan,
  type IssueRow,
  type Project,
  type ScanConfig,
  type ScanRecord,
} from '../db.js';
import { listRuleMessages } from '../knowledge.js';
import { engineAvailable, engineInstallHint, getEngineVersion } from '../engine.js';
import { engineUpgradeRunning } from '../engine-update.js';
import { diffSnapshots } from '../snapshot-diff.js';
import { packRuleFiles } from '../rulepacks.js';
import { buildSarifReport } from '../sarif.js';
import { parseSarifImport } from '../sarif-import.js';
import { buildReportData, renderReportHtml, type ReportLang } from '../report.js';
import { applyBaselineComparison, enqueueScan, requestScanCancel, type ScanPlan } from '../scan-runner.js';
import { asyncHandler, limit400, newId, requireProject, requireValidBaseline } from './shared.js';
import { isProjectImporting } from './projects.js';

export const scanRoutes = Router();

/** SARIF 导入的体积上限（文案从取数点引用） */
const MAX_SARIF_BYTES = 20 * 1024 * 1024;

function buildConfigPlan(project: Project): ScanPlan {
  if (!project.configId) {
    throw new HttpError(400, '项目未绑定扫描配置，请先在配置管理创建配置并在项目详情页绑定', {
      code: 'srv.configNotBound',
    });
  }
  const scanConfig = getConfig(project.configId);
  if (!scanConfig) {
    throw new HttpError(400, '项目绑定的扫描配置已不存在，请重新绑定', {
      code: 'srv.configGone',
    });
  }
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
    // rules 字段会作为「规则集」展示在扫描概要与报告里：落配置名（创建时限 50 字符）而非
    // cfg-xxx 内部 ID，用户才看得懂；可复现性由 configSnapshot.ruleFiles 的 sha256 保证
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

/** 一键扫描自动创建并复用的默认配置名（按名查找复用；seed 演示配置名不同，不会冲突） */
const DEFAULT_SCAN_CONFIG_NAME = '默认扫描配置';

/**
 * 一键扫描的兜底：确保「默认扫描配置」存在（全部启用的内置规则包，引擎参数与 configs 表列默认值一致），
 * 已存在则原样复用（尊重用户在配置页做过的调整）。没有可用内置包时返回 undefined，由调用方给出下一步指引。
 */
function ensureDefaultScanConfig(): ScanConfig | undefined {
  const existing = listConfigs().find((config) => config.name === DEFAULT_SCAN_CONFIG_NAME);
  if (existing) return existing;
  const rulePackIds = listRulePacks()
    .filter((pack) => pack.builtin && pack.enabled)
    .map((pack) => pack.id);
  if (rulePackIds.length === 0) return undefined;
  const scanConfig: ScanConfig = {
    id: newId('cfg'),
    name: DEFAULT_SCAN_CONFIG_NAME,
    description: '一键扫描自动创建：全部启用的内置规则包，可在扫描配置页调整',
    rulePackIds,
    excludes: [],
    includes: [],
    timeoutSeconds: 5,
    jobs: 4,
    maxTargetBytes: 1000000,
    createdAt: new Date().toISOString(),
  };
  insertConfig(scanConfig);
  return scanConfig;
}

/** 扫描编号带项目与时间信息（如 scan-mobsf-20261027-2301-x7k2）：记录一多也能一眼看出归属与日期 */
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

/** HTTP 头只放得下 ASCII：扫描编号可能含中文项目名，ASCII 回退文件名必须剥掉非 ASCII，完整名走 filename*（RFC 5987） */
function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7E]+/g, '_');
}

function requireScan(id: string): ScanRecord {
  const scan = getScan(id);
  if (!scan) throw new HttpError(404, '扫描记录不存在或已被删除', { code: 'srv.scanNotFound' });
  return scan;
}

scanRoutes.post('/api/projects/:id/scans', asyncHandler(async (req, res) => {
  if (engineUpgradeRunning()) {
    throw new HttpError(409, '引擎升级进行中，请升级完成后再发起扫描', {
      code: 'srv.scanUpgradeBusy',
    });
  }
  const project = requireProject(req.params.id);
  // 导入（上传/克隆）进行中时 pending/src 是半成品：放行会让下面的快照复制拿到不完整源码，
  // 与上传/克隆入口的导入互斥同口径直接 409
  if (isProjectImporting(project.id)) {
    throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再试', {
      code: 'srv.projectImportBusy',
    });
  }
  const pendingDir = pendingSourceDir(project.id);
  if (!fs.existsSync(pendingDir)) {
    throw new HttpError(400, '请先上传源码或克隆仓库再发起扫描', { code: 'srv.noSourceToScan' });
  }
  // 引擎缺失在发扫描前同步拦截：否则快照复制、落库都做完后异步 runScan 才失败，
  // 列表里留下一条难以找回原因的失败记录；前置拦截直接给出修复指引（runScan 里的
  // 同款检查保留作双保险，覆盖服务运行期间引擎被删除的窗口）
  if (!engineAvailable()) {
    throw new HttpError(400, engineInstallHint(), { code: 'srv.engineMissing' });
  }

  // 一键路径：未绑配置时自动创建/复用「默认扫描配置」并绑定，免去先建配置再回来绑定的往返
  if (!project.configId) {
    const defaultConfig = ensureDefaultScanConfig();
    if (!defaultConfig) {
      throw new HttpError(
        400,
        '没有已启用的内置规则包，无法自动创建默认配置；请先在配置管理创建配置并在项目详情页绑定',
        { code: 'srv.noEnabledBuiltinPacks' },
      );
    }
    updateProject(project.id, { configId: defaultConfig.id });
    project.configId = defaultConfig.id;
  }

  const plan = buildConfigPlan(project);

  let baselineScanId: string | undefined;
  const baselineParam = req.body?.baselineScanId;
  if (baselineParam !== undefined && baselineParam !== null && baselineParam !== '') {
    baselineScanId = requireValidBaseline(project.id, baselineParam);
  } else if (project.baselineScanId) {
    // 项目级基线兜底走与 requireValidBaseline 同口径的自愈校验：旧数据里 projects.baseline_scan_id
    // 可能指向已删扫描（修复前 deleteScan 只清过 scans 表），失效就清掉引用并不带基线继续扫描，
    // 而不是静默把死 ID 落进新扫描、让项目被 400 永久卡死
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
  // 异步逐文件复制，快照复制（上限 1GB）期间事件循环不再冻结；不用 fs.cpSync：
  // Node 22 在 Windows 上源路径含非 ASCII 字符时会直接终止进程（见 copyDirectory 注释）
  await copyDirectory(pendingDir, scanDir);

  insertScan(scan);
  enqueueScan(scan.id, plan);
  res.status(201).json(scan);
}));

scanRoutes.get('/api/projects/:id/scans', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  res.json(listScans(req.params.id));
}));

/** 全量扫描列表（跨项目对比的候选池） */
scanRoutes.get('/api/scans', asyncHandler(async (_req, res) => {
  res.json(listAllScans());
}));

scanRoutes.get('/api/scans/:scanId', asyncHandler(async (req, res) => {
  res.json(requireScan(req.params.scanId));
}));

scanRoutes.delete('/api/scans/:scanId', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  // 进行中的扫描还被引擎写入、快照目录被占用（Windows 上删目录会 EPERM，留下 DB 已删的矛盾状态）
  if (scan.status === 'scanning') {
    throw new HttpError(409, '扫描进行中，请等扫描完成或失败后再删除', { code: 'srv.scanBusy' });
  }
  deleteScan(scan.id);
  // 连快照根目录（workspace/<项目id>/<扫描id>/）一起删：只删 src 会让父目录成为随删除次数
  // 累积的永久空壳；force 兜底根目录从未落盘的情况（如 SARIF 导入的扫描没有快照）
  fs.rmSync(scanSnapshotRoot(scan.projectId, scan.id), { recursive: true, force: true });
  res.status(204).end();
}));

/**
 * 取消进行中的扫描（与 DELETE 语义区分：取消保留记录与快照，落 failed 供查看原因；DELETE 才清数据）。
 * - 引擎运行中：终止引擎进程（走 runEngine 既有 kill 链），runScan 收尾按"已被手动取消"落库后记录才变 failed；
 *   期间 hasRunningScan 仍为 true，升级闸保持关闭，确保 Windows 上不会替换运行中的引擎 exe
 * - 排队中/引擎尚未启动：没有可杀的进程，直接落库失败，槽位轮到时 runScan 复查状态自动退出
 */
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
    // 排队中取消时同步清排队标记（非排队扫描本就无值，置 null 无副作用）：
    // 原实现要等槽位轮转才清，期间重启会变成 status=failed + queuedAt 永久残留的矛盾数据
    queuedAt: null,
  });
  res.json({ status: 'failed' });
}));

scanRoutes.get('/api/scans/:scanId/issues', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  const issues = listIssues(scan.id);
  // 人工复核以 (项目, fingerprint) 为键跨扫描继承；污点链解析为结构化步骤
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
  try {
    const stat = fs.statSync(full);
    if (stat.isFile() && stat.size <= config.maxSnippetFileBytes) {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      from = Math.max(1, from);
      to = Math.min(lines.length, to);
      content = lines.slice(from - 1, to).join('\n');
    }
  } catch {
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

  // 高亮行取请求区间与切片区间的交集：若按原始 [startLine, endLine] 迭代，
  // 超大 end（如 Number.MAX_SAFE_INTEGER）会空转约 9e15 次拖死事件循环；
  // 交集上界受切片区间约束（文件路径 ≤ 文件行数，归档路径 ≤ issue.endLine），迭代次数有界
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
  const engineVersion = scan.engineVersion ?? (await getEngineVersion());
  const data = buildReportData(scan, project, issues, engineVersion, listReviews(scan.projectId));

  const format = String(req.query.format ?? 'json');
  if (format === 'html') {
    const includeSnippets = req.query.detail !== 'summary';
    const lang = parseProductLang(req.query.lang);
    // 中文语境附规则说明映射（明细一句话 + 附录），英文直接用引擎原文
    const messages = lang === 'en' ? undefined : listRuleMessages(lang);
    const html = renderReportHtml(data, issues, { includeSnippets }, lang, messages);
    const prefix = lang === 'zh-Hant' ? '測試報告' : lang === 'en' ? 'test-report' : '测试报告';
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

/** SARIF 2.1.0 导出：接入 GitHub Code Scanning / DefectDojo / SonarQube 等现有工具链 */
scanRoutes.get('/api/scans/:scanId/sarif', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status !== 'completed') {
    throw new HttpError(400, '仅已完成的扫描可导出 SARIF', { code: 'srv.sarifNotCompleted' });
  }
  const issues = listIssues(scan.id);
  const engineVersion = scan.engineVersion ?? (await getEngineVersion());
  const sarif = buildSarifReport(scan, issues, engineVersion);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="sarif-${asciiFilename(scan.id)}.json"; filename*=UTF-8''${encodeURIComponent(`SARIF-${scan.id}.json`)}`,
  );
  res.json(sarif);
}));

const importSarifUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SARIF_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!/\.(sarif|json)$/i.test(file.originalname)) {
      cb(new HttpError(400, '仅支持 .sarif / .json 文件', { code: 'srv.sarifOnly' }));
      return;
    }
    cb(null, true);
  },
});

/**
 * SARIF 导入：把外部工具的扫描结果（Semgrep / CodeQL / 其他 Studio 实例导出的 SARIF）
 * 引入为本项目的一条"已完成"扫描，统一参与结果页、报告与基线对比；
 * 可选 baselineScanId 与 POST /scans 同一套校验，导入即完成对比。
 */
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
      rules: `SARIF 导入（${toolName}）`,
      fileCount: 0,
    };
    for (const issue of issues) issue.scanId = scan.id;
    applyBaselineComparison(issues, scan.id, baselineScanId);
    scan.issueCount = issues.filter(isActiveIssue).length;

    insertScan(scan);
    replaceIssues(scan.id, issues);
    console.log(
      `[sarif-import] 项目 ${project.id} 导入 ${req.file.originalname}（${toolName}）：` +
        `${scan.issueCount} 个问题`,
    );
    res.status(201).json(scan);
  }),
);

/** 报告/清单共用的语言参数：只认 zh / zh-Hant / en，其余一律回落简体 */
function parseProductLang(value: unknown): ReportLang {
  return value === 'zh-Hant' ? 'zh-Hant' : value === 'en' ? 'en' : 'zh';
}

/** 扫描可复现清单：源码哈希 + 完整引擎命令行 + 规则文件哈希 + 引擎参数快照 */
scanRoutes.get('/api/scans/:scanId/manifest', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  const project = getProject(scan.projectId);
  const engineVersion = scan.engineVersion ?? (await getEngineVersion());
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
      binary: path.resolve(config.opengrepBin),
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
    commandLine: scan.commandLine ?? null,
    config: scan.configSnapshot ?? null,
    baselineScanId: scan.baselineScanId ?? null,
  });
}));

// ---------- 无 Git 双快照 diff（P1-4） ----------

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
  const fileDiff = await diffSnapshots(srcDir, againstDir);

  // 基线扫描会把已修复问题以 comparisonStatus='fixed' 追加落库（见 applyBaselineComparison），
  // 这里与结果页三分类同口径把它排除，否则 fixed 副本会被当作"当前存在/当前独有"，数字互相矛盾
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
    // 跨引擎版本的基线对比有噪音（新引擎会新增检测、修复误报），界面据此给出标识
    engine: {
      current: scan.engineVersion ?? null,
      against: against.engineVersion ?? null,
      mismatch: Boolean(
        scan.engineVersion && against.engineVersion && scan.engineVersion !== against.engineVersion,
      ),
    },
  });
}));
