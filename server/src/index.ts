import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  config,
  engineSource,
  pendingSourceDir,
  projectWorkspace,
  scanSourceDir,
} from './config.js';
import {
  collectLanguageStats,
  copyDirectory,
  extractArchive,
  extractZipSafely,
  isArchiveFileName,
  isPathWithin,
  safeRelativePath,
} from './archive.js';
import { pruneIgnoredFiles } from './ignore-filter.js';
import { HttpError } from './errors.js';
import {
  engineAvailable,
  engineDisplayPath,
  engineInstallHint,
  engineSourceLabel,
  getEngineVersion,
  terminateTrackedChildren,
} from './engine.js';
import { engineTargetVersion } from './engine-manifest.js';
import {
  checkEngineUpdate,
  engineUpgradeRunning,
  engineUpgradeState,
  startEngineUpgrade,
} from './engine-update.js';
import {
  deleteConfig,
  deleteProject,
  deleteReview,
  deleteRulePack,
  getConfig,
  getIssue,
  getProject,
  getRulePack,
  getScan,
  isActiveIssue,
  insertConfig,
  insertProject,
  insertRulePack,
  insertScan,
  listAllScans,
  listConfigs,
  listIssues,
  listProjects,
  listReviews,
  listRulePacks,
  listScans,
  replaceIssues,
  updateConfig,
  updateProject,
  updateRulePack,
  upsertReview,
  deleteScan,
  type IssueRow,
  type Project,
  type Review,
  type RulePack,
  type ScanConfig,
  type ScanRecord,
} from './db.js';
import { diffSnapshots } from './snapshot-diff.js';
import { getRuleKnowledge, isSafeSampleDirName } from './knowledge.js';
import { parseRuleYaml } from './rule-yaml.js';
import {
  builtinRulesDir,
  collectRuleFiles,
  customPackDir,
  customPackPath,
  packFilePath,
  packRuleFiles,
} from './rulepacks.js';
import { cloneRepo } from './git-clone.js';
import { cleanupRuleLabScratch, runPackCheck, runRuleLab, LANG_EXT } from './rule-lab.js';
import {
  buildLegacyManifestYaml,
  buildPackReadme,
  parsePackManifest,
  scanPackSamples,
  type PackManifest,
} from './pack-format.js';
import { buildSarifReport } from './sarif.js';
import { parseSarifImport } from './sarif-import.js';
import { buildReportData, renderReportHtml } from './report.js';
import {
  applyBaselineComparison,
  enqueueScan,
  hasRunningScan,
  markStaleScansFailed,
  type ScanPlan,
} from './scan-runner.js';

const app = express();
app.use(express.json());

/** 主机名是否指向本机：localhost 或 IP 字面量（IPv6 的 URL 形态带方括号，先剥掉） */
function isLocalHost(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || net.isIP(name) !== 0;
}

// 防 DNS 重绑定与跨站盲写：攻击页把自己的域名解析到 127.0.0.1 后，浏览器会带着攻击域名的
// Host 头访问本服务并视为同源（可读取扫描结果与源码片段）。因此 Host 必须是 localhost 或
// IP 字面量；带 Origin 的变更请求必须来自本机。经 IP 直连的局域网访问不受影响。
app.use((req, res, next) => {
  let hostOk = false;
  if (typeof req.headers.host === 'string') {
    try {
      hostOk = isLocalHost(new URL(`http://${req.headers.host.trim()}`).hostname);
    } catch {
      hostOk = false;
    }
  }
  if (!hostOk) {
    next(new HttpError(403, '拒绝访问：Host 头不是本机地址（防 DNS 重绑定）', { code: 'srv.hostNotAllowed' }));
    return;
  }
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && typeof origin === 'string') {
    let originOk = false;
    if (origin !== 'null') {
      try {
        originOk = isLocalHost(new URL(origin).hostname);
      } catch {
        originOk = false;
      }
    }
    if (!originOk) {
      next(new HttpError(403, '拒绝跨站请求：Origin 不是本机地址', { code: 'srv.originNotAllowed' }));
      return;
    }
  }
  next();
});

// 把 multer 的 LIMIT_FILE_SIZE 转成带该通道准确上限的 400（各通道上限不同，全局中间件无法区分）
function limit400(limited: import('express').RequestHandler, limitBytes: number): import('express').RequestHandler {
  return (req, res, next) => {
    limited(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(
          new HttpError(400, `文件超过 ${Math.round(limitBytes / 1024 / 1024)}MB 上传上限`, {
            code: 'srv.uploadTooLarge',
            params: { mb: Math.round(limitBytes / 1024 / 1024) },
          }),
        );
        return;
      }
      next(error);
    });
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

// 实验室与规则包质量检查共用一个全局互斥：单并发避免引擎进程堆积，也保证互不干扰
let engineJobBusy = false;

/** 规则包 YAML 上传与实验室运行的体积上限（同一策略，报错文案从这里取数） */
const MAX_RULE_YAML_BYTES = 1024 * 1024;
/** 规则包 zip 导入 / SARIF 导入的体积上限（两条独立通道，文案分别取数） */
const MAX_PACK_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_SARIF_BYTES = 20 * 1024 * 1024;

const uploadYaml = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RULE_YAML_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!/\.ya?ml$/i.test(file.originalname)) {
      cb(new HttpError(400, '仅支持 .yaml / .yml 规则包文件', { code: 'srv.yamlOnly' }));
      return;
    }
    cb(null, true);
  },
});

const BUILTIN_LANG_LABELS: Record<string, string> = {
  python: 'Python',
  'js-ts': 'JavaScript / TypeScript',
  java: 'Java',
  go: 'Go',
  c: 'C',
  csharp: 'C#',
  php: 'PHP',
  bash: 'Bash',
  kotlin: 'Kotlin',
  swift: 'Swift',
  rust: 'Rust',
  dockerfile: 'Dockerfile',
};

function ensureBuiltinRulePacks(): void {
  if (!fs.existsSync(builtinRulesDir)) return;
  for (const entry of fs.readdirSync(builtinRulesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const lang = entry.name.replace(/\.ya?ml$/i, '');
    const id = `builtin-${lang}`;
    let ruleCount = 0;
    try {
      ruleCount = parseRuleYaml(
        fs.readFileSync(path.join(builtinRulesDir, entry.name), 'utf8'),
      ).ruleCount;
    } catch (error) {
      console.log(
        `[rulepack] 内置规则包 ${entry.name} 解析失败，跳过注册: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    const label = BUILTIN_LANG_LABELS[lang] ?? lang;
    const existing = getRulePack(id);
    if (!existing) {
      insertRulePack({
        id,
        name: `${label} 内置安全规则包`,
        language: label,
        builtin: true,
        enabled: true,
        ruleCount,
        createdAt: new Date().toISOString(),
      });
      console.log(`[rulepack] 已注册内置规则包 ${id}（${ruleCount} 条规则）`);
    } else {
      const name = `${label} 内置安全规则包`;
      if (
        existing.ruleCount !== ruleCount ||
        existing.name !== name ||
        existing.language !== label
      ) {
        updateRulePack(id, { ruleCount, name, language: label });
        console.log(`[rulepack] 已刷新内置规则包 ${id}：${name}（${ruleCount} 条规则）`);
      }
    }
  }
}

/** 清理失效的内置规则包注册（对应 YAML 已从 security/ 移除的），不动其余内置包与配置勾选 */
function pruneStaleBuiltinPacks(): void {
  for (const pack of listRulePacks()) {
    if (pack.builtin && !fs.existsSync(packFilePath(pack))) {
      deleteRulePack(pack.id);
      console.log(`[rulepack] 已清理失效的内置规则包 ${pack.id}`);
    }
  }
}

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
    rulesLabel: scanConfig.id,
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

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireProject(id: string): Project {
  const project = getProject(id);
  if (!project) throw new HttpError(404, '项目不存在或已被删除', { code: 'srv.projectNotFound' });
  return project;
}

function requireScan(id: string): ScanRecord {
  const scan = getScan(id);
  if (!scan) throw new HttpError(404, '扫描记录不存在或已被删除', { code: 'srv.scanNotFound' });
  return scan;
}

app.get('/api/health', asyncHandler(async (_req, res) => {
  const engineReady = engineAvailable();
  res.json({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    // 实际探测的版本（引擎缺失时为 undefined）；清单钉住的版本单独给出，避免"版本漂移看不出来"
    engineVersion: engineReady ? await getEngineVersion() : undefined,
    enginePinnedVersion: engineTargetVersion(),
    // 只有安装位引擎能被一键升级：env / PATH 来源交给用户自己管
    engineManaged: engineReady && engineSource === 'bundled-dir',
    engine: engineReady ? engineDisplayPath() : 'MISSING',
    engineSource,
    engineSourceLabel: engineSourceLabel(),
    ...(engineReady ? {} : { engineHint: engineInstallHint() }),
  });
}));

// ---------- 引擎版本检查与一键升级 ----------

app.get('/api/engine/update', asyncHandler(async (req, res) => {
  res.json(await checkEngineUpdate(req.query.refresh === '1'));
}));

// 升级在后台跑，前端轮询这个接口拿进度（50MB 下载不能让请求一直挂着）
app.get('/api/engine/upgrade', (_req, res) => {
  res.json(engineUpgradeState());
});

app.post('/api/engine/upgrade', asyncHandler(async (_req, res) => {
  if (hasRunningScan()) {
    throw new HttpError(409, '有扫描任务正在运行，请等扫描结束后再升级引擎', {
      code: 'srv.upgradeScanBusy',
    });
  }
  if (engineJobBusy) {
    throw new HttpError(409, '规则实验室或规则包质量检查正在运行，请稍后再升级引擎', {
      code: 'srv.upgradeJobBusy',
    });
  }
  res.status(202).json(await startEngineUpgrade());
}));

// 规则说明按语言分包：文件名与语言标签一一对应；文件缺失时回空表，前端自然回落规则原文
function serveRuleMessages(fileName: string) {
  return (_req: Request, res: Response) => {
    try {
      res.json(JSON.parse(fs.readFileSync(path.join(config.rulesDir, fileName), 'utf8')));
    } catch {
      res.json({});
    }
  };
}

app.get('/api/messages-zh', serveRuleMessages('messages-zh.json'));
app.get('/api/messages-zh-Hant', serveRuleMessages('messages-zh-Hant.json'));

function requireValidConfigValues(body: Record<string, unknown>, existingId?: string) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '配置名称不能为空', { code: 'srv.configNameRequired' });
  if (name.length > 50) throw new HttpError(400, '配置名称不能超过 50 个字符', { code: 'srv.configNameTooLong' });
  const duplicated = listConfigs().some(
    (item) => item.name === name && item.id !== existingId,
  );
  if (duplicated) throw new HttpError(400, '配置名称已存在', { code: 'srv.configNameExists' });

  const rulePackIds = Array.isArray(body?.rulePackIds) ? body.rulePackIds.map(String) : [];
  if (rulePackIds.length === 0) throw new HttpError(400, '请至少勾选 1 个规则包', { code: 'srv.packsRequired' });
  for (const packId of rulePackIds) {
    if (!getRulePack(packId)) {
      throw new HttpError(400, `规则包 ${packId} 不存在`, {
        code: 'srv.packNotFoundById',
        params: { id: packId },
      });
    }
  }
  const asStringArray = (value: unknown) =>
    Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  const timeoutSeconds = Number(body?.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new HttpError(400, '单文件超时须为 1–600 的整数', { code: 'srv.timeoutInvalid' });
  }
  const jobs = Number(body?.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
    throw new HttpError(400, '并发数须为 1–16 的整数', { code: 'srv.jobsInvalid' });
  }
  const maxTargetBytes = Number(body?.maxTargetBytes);
  if (!Number.isFinite(maxTargetBytes) || maxTargetBytes < 100_000 || maxTargetBytes > 100_000_000) {
    throw new HttpError(400, '文件体积上限须在 0.1–100 MB 之间', { code: 'srv.sizeInvalid' });
  }
  return {
    name,
    description: String(body?.description ?? '').trim() || undefined,
    rulePackIds: [...new Set(rulePackIds)],
    excludes: asStringArray(body?.excludes),
    includes: asStringArray(body?.includes),
    timeoutSeconds,
    jobs,
    maxTargetBytes: Math.round(maxTargetBytes),
  };
}

/** 基线校验：必须是本项目下已完成的扫描（POST /scans、PATCH /projects、SARIF 导入共用） */
function requireValidBaseline(projectId: string, baselineParam: unknown): string {
  const scan = getScan(String(baselineParam));
  if (!scan || scan.projectId !== projectId || scan.status !== 'completed') {
    throw new HttpError(400, '基线必须是本项目下已完成的扫描', { code: 'srv.baselineInvalid' });
  }
  return scan.id;
}

/** 规则包名称校验（创建 / 上传 / 导入三条入口共用） */
function requireValidPackName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new HttpError(400, '请输入规则包名称', { code: 'srv.packNameRequired' });
  if (name.length > 50) {
    throw new HttpError(400, '规则包名称不能超过 50 个字符', { code: 'srv.packNameTooLong' });
  }
  return name;
}

app.get('/api/configs', (_req, res) => {
  res.json(listConfigs());
});

app.post('/api/configs', asyncHandler(async (req, res) => {
  const values = requireValidConfigValues(req.body ?? {});
  const scanConfig: ScanConfig = {
    id: newId('cfg'),
    ...values,
    createdAt: new Date().toISOString(),
  };
  insertConfig(scanConfig);
  res.status(201).json(scanConfig);
}));

app.put('/api/configs/:id', asyncHandler(async (req, res) => {
  const existing = getConfig(req.params.id);
  if (!existing) {
    throw new HttpError(404, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
  }
  const values = requireValidConfigValues(req.body ?? {}, existing.id);
  updateConfig(existing.id, values);
  res.json(getConfig(existing.id));
}));

app.delete('/api/configs/:id', asyncHandler(async (req, res) => {
  const existing = getConfig(req.params.id);
  if (!existing) {
    throw new HttpError(404, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
  }
  deleteConfig(existing.id);
  res.status(204).end();
}));

app.get('/api/rulepacks', (_req, res) => {
  res.json(listRulePacks());
});

function saveNewRulePack(name: string, language: string, yamlText: string, source?: string) {
  const { ruleCount } = parseRuleYaml(yamlText);
  fs.mkdirSync(config.customRulesDir, { recursive: true });
  const packId = newId('rp');
  const targetPath = customPackPath(packId);
  fs.writeFileSync(targetPath, yamlText, 'utf8');
  if (source) {
    console.log(`[rulepack] 规则包 ${packId}（${name}）已创建，来源: ${source}`);
  }
  const pack = {
    id: packId,
    name,
    language,
    builtin: false,
    enabled: true,
    ruleCount,
    createdAt: new Date().toISOString(),
  };
  insertRulePack(pack);
  return pack;
}

/**
 * 规则实验室"另存为新规则包"（带测试样本）：落成可移植目录包
 * （pack.yaml + rules/rule.yaml + samples/<首个规则id>/），样本随包分发、可一键质量检查。
 */
function savePortablePackFromLab(
  name: string,
  language: string,
  yamlText: string,
  samples: { positive: string; negative: string },
): RulePack {
  const parsed = parseRuleYaml(yamlText);
  // 规则 id 来自 YAML（不受信输入），落盘前必须确保可作单级样本目录名，否则会写出 customRulesDir
  if (parsed.ruleIds[0] && !isSafeSampleDirName(parsed.ruleIds[0])) {
    throw new HttpError(
      400,
      `首个规则 id「${parsed.ruleIds[0]}」含不安全字符，无法作为样本目录名；请修改 YAML 中的规则 id 后重试`,
    );
  }
  fs.mkdirSync(config.customRulesDir, { recursive: true });
  const packId = newId('rp');
  const dir = customPackDir(packId);
  const manifestText = buildLegacyManifestYaml({
    name,
    createdAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.yaml'), manifestText, 'utf8');
  fs.writeFileSync(path.join(dir, 'rules', 'rule.yaml'), yamlText, 'utf8');

  let sampleCount = 0;
  const ext = LANG_EXT[parsed.firstLanguage.toLowerCase()];
  if (ext && parsed.ruleIds[0]) {
    const sampleDir = path.join(dir, 'samples', parsed.ruleIds[0]);
    fs.mkdirSync(sampleDir, { recursive: true });
    if (samples.positive.trim()) {
      fs.writeFileSync(path.join(sampleDir, `positive.${ext}`), samples.positive, 'utf8');
      sampleCount += 1;
    }
    if (samples.negative.trim()) {
      fs.writeFileSync(path.join(sampleDir, `negative.${ext}`), samples.negative, 'utf8');
      sampleCount += 1;
    }
  }

  const manifest = parsePackManifest(manifestText);
  const pack: RulePack = {
    id: packId,
    name,
    language,
    builtin: false,
    enabled: true,
    ruleCount: parsed.ruleCount,
    createdAt: new Date().toISOString(),
    version: manifest.version,
    manifest,
    sampleCount,
    isDir: true,
    lastCheck: null,
  };
  insertRulePack(pack);
  console.log(
    `[rulepack] 规则包 ${packId}（${name}）已创建，来源: rule-lab（${parsed.ruleCount} 条规则、${sampleCount} 个样本）`,
  );
  return pack;
}

const MAX_SAMPLE_BYTES = 200 * 1024;

app.post('/api/rulepacks', asyncHandler(async (req, res) => {
  if (req.is('multipart/form-data')) {
    res.status(400).json({ error: { message: '文件上传请使用 /api/rulepacks/upload' } });
    return;
  }
  const name = requireValidPackName(req.body?.name);
  const language = String(req.body?.language ?? '').trim() || 'Java';
  const content = String(req.body?.content ?? '');
  if (!content.trim()) {
    throw new HttpError(400, '请输入规则包 YAML 内容', { code: 'srv.packContentRequired' });
  }
  const samples = {
    positive: String(req.body?.samples?.positive ?? ''),
    negative: String(req.body?.samples?.negative ?? ''),
  };
  if (samples.positive.length > MAX_SAMPLE_BYTES || samples.negative.length > MAX_SAMPLE_BYTES) {
    throw new HttpError(
      400,
      `单个测试样本超过 ${MAX_SAMPLE_BYTES / 1024}KB 上限`,
      { code: 'srv.sampleTooLarge', params: { kb: MAX_SAMPLE_BYTES / 1024 } },
    );
  }
  const hasSamples = Boolean(samples.positive.trim() || samples.negative.trim());
  try {
    const pack = hasSamples
      ? savePortablePackFromLab(name, language, content, samples)
      : saveNewRulePack(name, language, content, 'online-editor');
    res.status(201).json(pack);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}));

app.patch('/api/rulepacks/:id', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    throw new HttpError(400, '需要 enabled 布尔字段', { code: 'srv.enabledRequired' });
  }
  updateRulePack(pack.id, { enabled });
  res.json({ ...pack, enabled });
}));

app.post(
  '/api/rulepacks/upload',
  limit400(uploadYaml.single('file'), MAX_RULE_YAML_BYTES),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, '请通过 multipart 表单上传 file 字段', { code: 'srv.fileRequired' });
    }
    const name = requireValidPackName(req.body?.name);
    const language = String(req.body?.language ?? '').trim() || 'Java';
    const content = req.file.buffer.toString('utf8');
    try {
      res.status(201).json(saveNewRulePack(name, language, content, req.file.originalname));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }),
);

app.get('/api/rulepacks/:id/content', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  if (pack.isDir) {
    throw new HttpError(400, '目录式规则包含多个规则文件与样本，暂不支持在线查看/编辑', {
      code: 'srv.dirPackNotViewable',
    });
  }
  const filePath = packFilePath(pack);
  if (!fs.existsSync(filePath)) {
    throw new HttpError(404, '规则包文件已丢失', { code: 'srv.packFileMissing' });
  }
  res.json({ id: pack.id, name: pack.name, language: pack.language, content: fs.readFileSync(filePath, 'utf8') });
}));

app.put('/api/rulepacks/:id/content', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  if (pack.builtin) {
    throw new HttpError(403, '内置规则包不可在线编辑，请通过 server/scripts/curate-rules.py 更新', {
      code: 'srv.builtinNotEditable',
    });
  }
  if (pack.isDir) {
    throw new HttpError(
      400,
      '目录式规则包含多个规则文件与样本，暂不支持在线编辑；可在规则实验室调试后重新导出',
      { code: 'srv.dirPackNotEditable' },
    );
  }
  const content = String(req.body?.content ?? '');
  if (!content.trim()) {
    throw new HttpError(400, '请输入规则包 YAML 内容', { code: 'srv.packContentRequired' });
  }
  let ruleCount: number;
  try {
    ruleCount = parseRuleYaml(content).ruleCount;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  fs.writeFileSync(customPackPath(pack.id), content, 'utf8');
  updateRulePack(pack.id, { ruleCount });
  res.json({ ...pack, ruleCount });
}));

app.delete('/api/rulepacks/:id', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  if (pack.builtin) {
    throw new HttpError(403, '内置规则包不可删除，如不需要可在配置中取消勾选或停用', {
      code: 'srv.builtinNotDeletable',
    });
  }
  deleteRulePack(pack.id);
  fs.rmSync(customPackPath(pack.id), { force: true });
  fs.rmSync(customPackDir(pack.id), { recursive: true, force: true });
  res.status(204).end();
}));

function safePackFolderName(name: string): string {
  const sanitized = name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.slice(0, 40) || 'rulepack';
}

/** 导出 zip 内的贡献规范 README（P1-7）：逐规则样本清单 + 用法 + 许可声明；包内已有手写 README 时不覆盖 */
function buildExportReadme(pack: RulePack, packDir?: string): string {
  const inventory: Array<{ ruleId: string; positiveCount: number; negativeCount: number }> = [];
  const knownIds = new Set<string>();
  try {
    if (packDir) {
      for (const file of collectRuleFiles(path.join(packDir, 'rules'))) {
        const parsed = parseRuleYaml(fs.readFileSync(file, 'utf8'));
        for (const id of parsed.ruleIds) {
          if (!knownIds.has(id)) {
            knownIds.add(id);
            inventory.push({ ruleId: id, positiveCount: 0, negativeCount: 0 });
          }
        }
      }
      const { byRule } = scanPackSamples(packDir, knownIds);
      for (const item of inventory) {
        const set = byRule.get(item.ruleId);
        item.positiveCount = set?.positives.length ?? 0;
        item.negativeCount = set?.negatives.length ?? 0;
      }
    } else {
      const parsed = parseRuleYaml(fs.readFileSync(customPackPath(pack.id), 'utf8'));
      for (const id of parsed.ruleIds) {
        inventory.push({ ruleId: id, positiveCount: 0, negativeCount: 0 });
      }
    }
  } catch (error) {
    throw new HttpError(
      400,
      `规则包内容无法解析，导出中止：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return buildPackReadme({
    name: pack.name,
    version: pack.version,
    description: pack.manifest?.description,
    descriptionEn: pack.manifest?.descriptionEn,
    author: pack.manifest?.author,
    license: pack.manifest?.license,
    frameworks: pack.manifest?.frameworks,
    cwe: pack.manifest?.cwe,
    owasp: pack.manifest?.owasp,
    changelog: pack.manifest?.changelog,
    language: pack.language,
    ruleCount: pack.ruleCount,
    inventory,
    lastCheck: pack.lastCheck,
  });
}

/** 导出可移植规则包 zip：目录包原样打包；单文件包自动生成 pack.yaml 清单（basic 档）；缺 README 时注入贡献规范版 */
app.get('/api/rulepacks/:id/export', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  if (pack.builtin) {
    throw new HttpError(403, '内置规则包不可导出，请从官方 opengrep-rules 仓库获取', {
      code: 'srv.builtinNotExportable',
    });
  }
  const zip = new AdmZip();
  let fileName: string;
  if (pack.isDir) {
    const dir = customPackDir(pack.id);
    if (!fs.existsSync(dir)) throw new HttpError(404, '规则包目录已丢失', { code: 'srv.packDirMissing' });
    const folder = safePackFolderName(pack.name);
    zip.addLocalFolder(dir, folder);
    if (!fs.existsSync(path.join(dir, 'README.md'))) {
      zip.addFile(`${folder}/README.md`, Buffer.from(buildExportReadme(pack, dir), 'utf8'));
    }
    fileName = `${safePackFolderName(pack.name)}-v${pack.version ?? '0.1.0'}.zip`;
  } else {
    const file = customPackPath(pack.id);
    if (!fs.existsSync(file)) throw new HttpError(404, '规则包文件已丢失', { code: 'srv.packFileMissing' });
    zip.addFile('pack.yaml', Buffer.from(buildLegacyManifestYaml(pack), 'utf8'));
    zip.addFile(`rules/${safePackFolderName(pack.name)}.yaml`, fs.readFileSync(file));
    zip.addFile('README.md', Buffer.from(buildExportReadme(pack), 'utf8'));
    fileName = `${safePackFolderName(pack.name)}-v0.1.0.zip`;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pack-${pack.id}.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.send(zip.toBuffer());
}));

const importPackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PACK_ZIP_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!/\.zip$/i.test(file.originalname)) {
      cb(new HttpError(400, '仅支持 .zip 规则包压缩包', { code: 'srv.zipOnly' }));
      return;
    }
    cb(null, true);
  },
});

/** 判断解压后的 zip 根：pack.yaml 在根目录，或恰有一个含 pack.yaml 的子目录 */
function detectPackRoot(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'pack.yaml'))) return dir;
  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (children.length === 1) {
    const child = path.join(dir, children[0].name);
    if (fs.existsSync(path.join(child, 'pack.yaml'))) return child;
  }
  return null;
}

/** 散装 YAML 的搜索根：顶层无文件且恰有一个子目录时下钻一层（Windows 右键压缩文件夹的产物形态） */
function detectLooseRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile())) return dir;
  const dirs = entries.filter((entry) => entry.isDirectory());
  return dirs.length === 1 ? path.join(dir, dirs[0].name) : dir;
}

app.post(
  '/api/rulepacks/import',
  limit400(importPackUpload.single('file'), MAX_PACK_ZIP_BYTES),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, '请通过 multipart 表单上传 file 字段（.zip）', {
        code: 'srv.fileRequired',
      });
    }
    const zipName = req.file.originalname.replace(/\.zip$/i, '');
    const tmpDir = path.join(os.tmpdir(), `ogpack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      extractZipSafely(req.file.buffer, tmpDir);
      const root = detectPackRoot(tmpDir);

      if (root) {
        // 可移植格式：pack.yaml + rules/ + samples/
        let manifest: PackManifest;
        try {
          manifest = parsePackManifest(fs.readFileSync(path.join(root, 'pack.yaml'), 'utf8'));
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        const ruleFiles = collectRuleFiles(path.join(root, 'rules'));
        if (ruleFiles.length === 0) {
          throw new HttpError(400, '包内 rules/ 目录没有任何 YAML 规则文件', {
            code: 'srv.noRulesInZip',
          });
        }
        if (ruleFiles.length > 50) {
          throw new HttpError(400, '规则文件数超过 50 上限，请拆分规则包', {
            code: 'srv.tooManyRuleFiles',
          });
        }
        const ids = new Set<string>();
        let ruleCount = 0;
        let language = '';
        for (const file of ruleFiles) {
          let text: string;
          try {
            text = fs.readFileSync(file, 'utf8');
            const parsed = parseRuleYaml(text);
            if (!language && parsed.firstLanguage) {
              language = parsed.firstLanguage;
            }
            for (const id of parsed.ruleIds) {
              if (ids.has(id)) throw new Error(`存在重复的规则 id：${id}`);
              ids.add(id);
              ruleCount += 1;
            }
          } catch (error) {
            const rel = path.relative(root, file).replace(/\\/g, '/');
            throw new HttpError(
              400,
              `规则文件 ${rel} 不合法：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const { sampleCount } = scanPackSamples(root, ids);
        const packId = newId('rp');
        const destDir = customPackDir(packId);
        fs.mkdirSync(config.customRulesDir, { recursive: true });
        // zip 顶层文件夹名不可控（可能含中文），必须用安全复制（见 copyDirectory 注释）
        await copyDirectory(root, destDir);
        const pack: RulePack = {
          id: packId,
          name: manifest.name,
          language: language || manifest.frameworks[0] || 'Other',
          builtin: false,
          enabled: true,
          ruleCount,
          createdAt: new Date().toISOString(),
          version: manifest.version,
          manifest,
          sampleCount,
          isDir: true,
          lastCheck: null,
        };
        insertRulePack(pack);
        res.status(201).json({
          ...pack,
          message: `导入成功：${ruleCount} 条规则、${sampleCount} 个样本，建议先运行质量检查`,
        });
        return;
      }

      // 无清单：单个散装 YAML 走旧式单文件包；多个则要求补齐可移植格式
      const looseRoot = detectLooseRoot(tmpDir);
      const looseFiles = fs
        .readdirSync(looseRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name));
      if (looseFiles.length === 0) {
        throw new HttpError(400, '压缩包中没有找到 YAML 规则文件', { code: 'srv.noYamlInZip' });
      }
      if (looseFiles.length > 1) {
        throw new HttpError(
          400,
          '压缩包含多个规则文件但缺少 pack.yaml 清单，请按可移植格式打包（pack.yaml + rules/ 目录）',
        );
      }
      const content = fs.readFileSync(path.join(looseRoot, looseFiles[0].name), 'utf8');
      const name = requireValidPackName(String(req.body?.name ?? '').trim() || zipName);
      let language = String(req.body?.language ?? '').trim();
      try {
        // 坏 YAML 在这里就拦下（否则 saveNewRulePack 内部抛普通 Error 会变成 500）
        language = language || parseRuleYaml(content).firstLanguage;
      } catch (error) {
        throw new HttpError(
          400,
          `规则文件 ${looseFiles[0].name} 不合法：${error instanceof Error ? error.message : String(error)}`,
          { code: 'srv.ruleFileInvalid', params: { name: looseFiles[0].name } },
        );
      }
      const pack = saveNewRulePack(name, language || 'Other', content, req.file.originalname);
      res.status(201).json({ ...pack, message: '导入成功（单文件包，无样本，basic 档）' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }),
);

/** 规则包质量检查：逐规则跑自己的正反例样本（复用实验室 runner），结果存为 lastCheck */
app.post('/api/rulepacks/:id/check', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  if (pack.builtin) {
    throw new HttpError(403, '内置规则包暂无样本，不支持质量检查', { code: 'srv.builtinNoSamples' });
  }
  if (!pack.isDir || !fs.existsSync(customPackDir(pack.id))) {
    throw new HttpError(400, '旧式单文件规则包没有样本可检查，请以可移植格式重新导入', {
      code: 'srv.noSamplesToCheck',
    });
  }
  if (engineUpgradeRunning()) {
    throw new HttpError(409, '引擎升级进行中，请升级完成后再做质量检查', {
      code: 'srv.checkUpgradeBusy',
    });
  }
  if (engineJobBusy) {
    throw new HttpError(409, '上一次引擎任务（实验室/质量检查）还在运行，请稍候再试', { code: 'srv.engineJobBusy' });
  }
  engineJobBusy = true;
  try {
    const result = await runPackCheck(customPackDir(pack.id));
    const count = (verdict: string) => result.items.filter((item) => item.verdict === verdict).length;
    const summary = {
      tier: result.tier,
      passed: count('pass'),
      failed: count('fail'),
      errors: count('error'),
      unverified: count('unverified'),
      checkedAt: new Date().toISOString(),
    };
    updateRulePack(pack.id, { lastCheck: summary });
    res.json({ ...result, summary });
  } finally {
    engineJobBusy = false;
  }
}));

app.get('/api/projects', (_req, res) => {
  res.json(listProjects());
});

app.post('/api/projects', asyncHandler(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '项目名称不能为空', { code: 'srv.projectNameRequired' });
  if (name.length > 50) {
    throw new HttpError(400, '项目名称不能超过 50 个字符', { code: 'srv.projectNameTooLong' });
  }
  const project: Project = {
    id: newId('p'),
    name,
    description: String(req.body?.description ?? '').trim() || undefined,
    language: String(req.body?.language ?? '').trim(),
    createdAt: new Date().toISOString(),
  };
  insertProject(project);
  res.status(201).json(project);
}));

app.patch('/api/projects/:id', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  const patch: Parameters<typeof updateProject>[1] = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, '项目名称不能为空', { code: 'srv.projectNameRequired' });
    patch.name = name;
  }
  if (req.body?.description !== undefined) {
    patch.description = String(req.body.description).trim() || null;
  }
  if (req.body?.language !== undefined) patch.language = String(req.body.language);
  if (req.body?.baselineScanId !== undefined) {
    const scanId = req.body.baselineScanId;
    if (scanId === null || scanId === '') {
      patch.baselineScanId = null;
    } else {
      patch.baselineScanId = requireValidBaseline(project.id, scanId);
    }
  }
  if (req.body?.configId !== undefined) {
    const configId = req.body.configId;
    if (configId === null || configId === '') {
      patch.configId = null;
    } else {
      const scanConfig = getConfig(String(configId));
      patch.configId = scanConfig ? scanConfig.id : null;
    }
  }
  updateProject(project.id, patch);
  res.json(getProject(project.id));
}));

app.delete('/api/projects/:id', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  // 进行中/排队中的扫描还在用项目工作区与 DB 行：放行删除会让引擎把 issue 写回已删的扫描，
  // Windows 上还会撞上被占用的目录（rmSync 抛 EPERM 但 DB 已删，留下自相矛盾的状态）
  if (listScans(project.id).some((scan) => scan.status === 'scanning')) {
    throw new HttpError(409, '项目有进行中的扫描，请等扫描完成后再删除', {
      code: 'srv.projectScanBusy',
    });
  }
  // 级联删除（扫描/问题/复核）在 db 层 deleteProject 内完成，路由不再重复调用
  deleteProject(project.id);
  fs.rmSync(projectWorkspace(project.id), { recursive: true, force: true });
  res.status(204).end();
}));

/**
 * 上传快照的忽略规则剪枝：默认开启（respectGitignore !== 'false'），
 * 按 .gitignore / .opengrepignore 过滤，使上传源码与 Git 仓库直扫的扫描口径一致；
 * 关闭后保留全部上传内容（用于排查 .env 等被忽略文件中的硬编码密钥）。
 */
function applyIgnoreFilter(
  destDir: string,
  preCount: number,
  respectGitignore: boolean,
): { fileCount: number; ignoredCount: number } {
  if (!respectGitignore) return { fileCount: preCount, ignoredCount: 0 };
  const { keptFiles, ignoredFiles } = pruneIgnoredFiles(destDir);
  if (keptFiles === 0) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new HttpError(
      400,
      '按 .gitignore 忽略规则过滤后没有剩余可扫描的文件，请检查忽略规则，或关闭“按 .gitignore 忽略文件”后重新上传',
    );
  }
  return { fileCount: keptFiles, ignoredCount: ignoredFiles };
}

/** 同一项目同一时刻只允许一个源码导入任务（上传/克隆），防止并发写同一个 pending 目录 */
const importingProjects = new Set<string>();

app.post(
  '/api/projects/:id/source',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: config.maxImportEntries },
  ]),
  asyncHandler(async (req, res) => {
    const project = requireProject(req.params.id);
    if (importingProjects.has(project.id)) {
      throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再试', {
        code: 'srv.projectImportBusy',
      });
    }
    importingProjects.add(project.id);
    try {
      const destDir = pendingSourceDir(project.id);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const archive = filesMap.file?.[0];
      const looseFiles = filesMap.files ?? [];
      const respectGitignore = req.body?.respectGitignore !== 'false';

      // 形态一：单个压缩包（ZIP / 7Z / RAR / TAR / TAR.GZ），按扩展名分发解压
      if (archive) {
        if (!isArchiveFileName(archive.originalname)) {
          throw new HttpError(
            400,
            '仅支持 ZIP / 7Z / RAR / TAR / TAR.GZ 压缩包，或直接拖入文件夹上传',
            { code: 'srv.archiveTypeUnsupported' },
          );
        }
        const extracted = await extractArchive(archive.buffer, destDir, archive.originalname);
        const { fileCount, ignoredCount } = applyIgnoreFilter(destDir, extracted, respectGitignore);
        const languageStats = collectLanguageStats(destDir);
        updateProject(project.id, { languageStats });
        const ignoreNote = ignoredCount > 0 ? `，已按 .gitignore 忽略 ${ignoredCount} 个文件` : '';
        res.json({
          fileName: archive.originalname,
          fileSize: archive.size,
          fileCount,
          ignoredCount,
          languageStats,
          message: `上传成功，已解压 ${fileCount} 个文件${ignoreNote}`,
        });
        return;
      }

      // 形态二：散装多文件（文件夹拖拽 / 目录选择），按相对路径落盘
      if (looseFiles.length > 0) {
        const pathsRaw = req.body?.paths;
        const relPaths = Array.isArray(pathsRaw)
          ? pathsRaw.map(String)
          : pathsRaw !== undefined
            ? [String(pathsRaw)]
            : [];
        if (relPaths.length !== looseFiles.length) {
          throw new HttpError(400, '文件列表与路径参数数量不匹配', { code: 'srv.filesMismatch' });
        }
        if (looseFiles.length > config.maxImportEntries) {
          throw new HttpError(400, `文件数超过 ${config.maxImportEntries} 上限`, {
            code: 'srv.tooManyFiles',
            params: { limit: config.maxImportEntries },
          });
        }
        let totalBytes = 0;
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        try {
          looseFiles.forEach((file, index) => {
            const rel = safeRelativePath(relPaths[index] || file.originalname);
            if (!rel) throw new HttpError(400, '文件路径不能为空', { code: 'srv.pathRequired' });
            const target = path.join(destDir, rel);
            if (!isPathWithin(destDir, target)) {
              throw new HttpError(400, `文件路径不安全：${relPaths[index]}`, {
                code: 'srv.unsafeFilePath',
                params: { path: relPaths[index] },
              });
            }
            totalBytes += file.size;
            if (totalBytes > config.maxExtractedBytes) {
              throw new HttpError(
                400,
                `总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
                { code: 'srv.totalTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
              );
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.buffer);
          });
        } catch (error) {
          // 中途失败不留半成品 pending 目录（否则后续扫描会拿到不完整源码）
          fs.rmSync(destDir, { recursive: true, force: true });
          throw error;
        }
        const firstSegments = relPaths.map((p) => p.replace(/\\/g, '/').split('/')[0]);
        const commonRoot =
          firstSegments.every((seg) => seg && seg === firstSegments[0]) && looseFiles.length > 1
            ? firstSegments[0]
            : undefined;
        const label =
          commonRoot ?? (looseFiles.length === 1 ? firstSegments[0] : `${looseFiles.length} 个文件`);
        const { fileCount, ignoredCount } = applyIgnoreFilter(destDir, looseFiles.length, respectGitignore);
        const languageStats = collectLanguageStats(destDir);
        updateProject(project.id, { languageStats });
        const ignoreNote = ignoredCount > 0 ? `，已按 .gitignore 忽略 ${ignoredCount} 个文件` : '';
        res.json({
          fileName: label,
          fileSize: totalBytes,
          fileCount,
          ignoredCount,
          languageStats,
          message: `上传成功，共 ${fileCount} 个文件${ignoreNote}`,
        });
        return;
      }

      throw new HttpError(400, '请通过 multipart 表单上传 file 或 files 字段', {
        code: 'srv.fileRequired',
      });
    } finally {
      importingProjects.delete(project.id);
    }
  }),
);

app.post('/api/projects/:id/clone', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  const url = String(req.body?.url ?? '').trim();
  if (!url) throw new HttpError(400, '请提供 Git 仓库地址', { code: 'srv.gitUrlRequired' });
  const ref = String(req.body?.ref ?? '').trim();
  if (importingProjects.has(project.id)) {
    throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再试', {
      code: 'srv.projectImportBusy',
    });
  }
  importingProjects.add(project.id);
  try {
    const destDir = pendingSourceDir(project.id);
    const { fileCount } = await cloneRepo(url, ref, destDir);
    const languageStats = collectLanguageStats(destDir);
    updateProject(project.id, { languageStats });
    res.json({
      url,
      ref: ref || 'HEAD',
      fileCount,
      languageStats,
      message: `克隆成功，共 ${fileCount} 个文件`,
    });
  } finally {
    importingProjects.delete(project.id);
  }
}));

app.post('/api/projects/:id/scans', asyncHandler(async (req, res) => {
  if (engineUpgradeRunning()) {
    throw new HttpError(409, '引擎升级进行中，请升级完成后再发起扫描', {
      code: 'srv.scanUpgradeBusy',
    });
  }
  const project = requireProject(req.params.id);
  const pendingDir = pendingSourceDir(project.id);
  if (!fs.existsSync(pendingDir)) {
    throw new HttpError(400, '请先上传源码或克隆仓库再发起扫描', { code: 'srv.noSourceToScan' });
  }

  // 一键路径：未绑配置时自动创建/复用「默认扫描配置」并绑定，免去先建配置再回来绑定的往返
  if (!project.configId) {
    const defaultConfig = ensureDefaultScanConfig();
    if (!defaultConfig) {
      throw new HttpError(
        400,
        '没有已启用的内置规则包，无法自动创建默认配置；请先在配置管理创建配置并在项目详情页绑定',
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
    baselineScanId = project.baselineScanId;
  }

  const scan: ScanRecord = {
    id: newId('scan'),
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

app.get('/api/projects/:id/scans', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  res.json(listScans(req.params.id));
}));

/** 全量扫描列表（跨项目对比的候选池） */
app.get('/api/scans', asyncHandler(async (_req, res) => {
  res.json(listAllScans());
}));

app.get('/api/scans/:scanId', asyncHandler(async (req, res) => {
  res.json(requireScan(req.params.scanId));
}));

app.delete('/api/scans/:scanId', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  // 进行中的扫描还被引擎写入、快照目录被占用（Windows 上删目录会 EPERM，留下 DB 已删的矛盾状态）
  if (scan.status === 'scanning') {
    throw new HttpError(409, '扫描进行中，请等扫描完成或失败后再删除', { code: 'srv.scanBusy' });
  }
  deleteScan(scan.id);
  fs.rmSync(scanSourceDir(scan.projectId, scan.id), { recursive: true, force: true });
  res.status(204).end();
}));

app.get('/api/scans/:scanId/issues', asyncHandler(async (req, res) => {
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

app.get('/api/scans/:scanId/snippet', asyncHandler(async (req, res) => {
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

  const highlightedLines: number[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    if (line >= from && line <= to) highlightedLines.push(line);
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

app.get('/api/scans/:scanId/report', asyncHandler(async (req, res) => {
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
    // 与知识库同一口径：只认已支持的两种语言，其余回落简体
    const lang = req.query.lang === 'zh-Hant' ? 'zh-Hant' : 'zh';
    const html = renderReportHtml(data, issues, { includeSnippets }, lang);
    const fileName = `${lang === 'zh-Hant' ? '測試報告' : '测试报告'}-${project.name}-${scan.id}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-${scan.id}.html"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(html);
    return;
  }
  res.json(data);
}));

/** SARIF 2.1.0 导出：接入 GitHub Code Scanning / DefectDojo / SonarQube 等现有工具链 */
app.get('/api/scans/:scanId/sarif', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  if (scan.status !== 'completed') {
    throw new HttpError(400, '仅已完成的扫描可导出 SARIF', { code: 'srv.sarifNotCompleted' });
  }
  const issues = listIssues(scan.id);
  const engineVersion = scan.engineVersion ?? (await getEngineVersion());
  const sarif = buildSarifReport(scan, issues, engineVersion);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="sarif-${scan.id}.json"; filename*=UTF-8''${encodeURIComponent(`SARIF-${scan.id}.json`)}`,
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
app.post(
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
      id: newId('scan'),
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

/** 扫描可复现清单：源码哈希 + 完整引擎命令行 + 规则文件哈希 + 引擎参数快照 */
app.get('/api/scans/:scanId/manifest', asyncHandler(async (req, res) => {
  const scan = requireScan(req.params.scanId);
  const project = getProject(scan.projectId);
  const engineVersion = scan.engineVersion ?? (await getEngineVersion());
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
      algorithm: 'sha256（按相对路径排序，对 路径 + \\0 + 文件内容 + \\0 序列计算）',
      sha256: scan.srcHash ?? null,
      fileCount: scan.fileCount,
    },
    commandLine: scan.commandLine ?? null,
    config: scan.configSnapshot ?? null,
    baselineScanId: scan.baselineScanId ?? null,
  });
}));

// ---------- 人工复核与证据链（P1-2） ----------

const REVIEW_STATUSES = ['confirmed', 'false_positive', 'accepted'] as const;

app.get('/api/projects/:id/reviews', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  res.json(listReviews(req.params.id));
}));

app.put('/api/projects/:id/reviews', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  const fingerprint = String(req.body?.fingerprint ?? '').trim();
  if (!fingerprint || fingerprint.length > 512) {
    throw new HttpError(400, '需要 fingerprint（问题指纹，512 字符以内）', {
      code: 'srv.fingerprintInvalid',
    });
  }
  const status = String(req.body?.status ?? '');
  if (!REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
    throw new HttpError(
      400,
      `status 仅支持：${REVIEW_STATUSES.join(' / ')}（重置请用 DELETE）`,
      { code: 'srv.reviewStatusInvalid', params: { statuses: REVIEW_STATUSES.join(' / ') } },
    );
  }
  const reason = String(req.body?.reason ?? '').trim();
  if (reason.length > 500) {
    throw new HttpError(400, '复核理由不能超过 500 字符', { code: 'srv.reasonTooLong' });
  }
  const reviewer = String(req.body?.reviewer ?? '').trim() || 'admin';
  if (reviewer.length > 100) {
    throw new HttpError(400, '复核人不能超过 100 字符', { code: 'srv.reviewerTooLong' });
  }
  const review: Review = {
    projectId: project.id,
    fingerprint,
    status: status as Review['status'],
    ...(reason ? { reason } : {}),
    reviewer,
    updatedAt: new Date().toISOString(),
  };
  upsertReview(review);
  res.json(review);
}));

app.delete('/api/projects/:id/reviews/:fingerprint', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  deleteReview(req.params.id, req.params.fingerprint);
  res.status(204).end();
}));

// ---------- 无 Git 双快照 diff（P1-4） ----------

app.get('/api/scans/:scanId/diff', asyncHandler(async (req, res) => {
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

  const currentMap = new Map(listIssues(scan.id).map((issue) => [issue.fingerprint, issue]));
  const againstMap = new Map(listIssues(against.id).map((issue) => [issue.fingerprint, issue]));
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

// ---------- 规则知识库（P1-5） ----------

app.get('/api/rules/knowledge/:ruleId', asyncHandler(async (req, res) => {
  const ruleId = String(req.params.ruleId ?? '').trim();
  if (!ruleId || ruleId.length > 200) {
    throw new HttpError(400, '需要 ruleId 路径参数', { code: 'srv.ruleIdInvalid' });
  }
  // 只认已支持的两种语言：非法值回落简体，避免任意 query 改变读取路径
  const lang = req.query.lang === 'zh-Hant' ? 'zh-Hant' : 'zh';
  res.json(getRuleKnowledge(ruleId, lang));
}));

app.post('/api/rulelab/run', asyncHandler(async (req, res) => {
  const yaml = String(req.body?.yaml ?? '');
  if (!yaml.trim()) throw new HttpError(400, '请输入规则 YAML', { code: 'srv.ruleYamlRequired' });
  if (yaml.length > MAX_RULE_YAML_BYTES) {
    throw new HttpError(
      400,
      `规则 YAML 超过 ${MAX_RULE_YAML_BYTES / 1024 / 1024}MB 上限`,
      { code: 'srv.ruleYamlTooLarge', params: { mb: MAX_RULE_YAML_BYTES / 1024 / 1024 } },
    );
  }
  const samples = {
    positive: String(req.body?.samples?.positive ?? ''),
    negative: String(req.body?.samples?.negative ?? ''),
  };
  if (samples.positive.length > MAX_SAMPLE_BYTES || samples.negative.length > MAX_SAMPLE_BYTES) {
    throw new HttpError(400, `单个测试样本超过 ${MAX_SAMPLE_BYTES / 1024}KB 上限`, {
      code: 'srv.sampleTooLarge',
      params: { kb: MAX_SAMPLE_BYTES / 1024 },
    });
  }
  const language = String(req.body?.language ?? '').trim() || undefined;
  if (engineUpgradeRunning()) {
    throw new HttpError(409, '引擎升级进行中，请升级完成后再运行实验室', { code: 'srv.labUpgradeBusy' });
  }
  if (engineJobBusy) {
    throw new HttpError(409, '上一次引擎任务（实验室/质量检查）还在运行，请稍候再试', { code: 'srv.engineJobBusy' });
  }
  engineJobBusy = true;
  try {
    res.json(await runRuleLab(yaml, samples, language));
  } finally {
    engineJobBusy = false;
  }
}));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { message: '接口不存在' } });
});

const distDir = path.join(import.meta.dirname, '..', '..', 'code', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') { next(); return; }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    // code/params 是可选契约：带 code 的错误前端按语言翻译，message 仍是各语言兜底
    const meta = error.meta?.code
      ? { code: error.meta.code, params: error.meta.params }
      : {};
    res.status(error.status).json({ error: { message: error.message, ...meta } });
    return;
  }
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `文件超过 ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB 上传上限`
        : `上传失败：${error.message}`;
    res.status(400).json({ error: { message } });
    return;
  }
  console.error('[server] 未处理异常:', error);
  res.status(500).json({ error: { message: '服务器内部错误' } });
});

const server = app.listen(config.port, config.host, () => {
  ensureBuiltinRulePacks();
  pruneStaleBuiltinPacks();
  markStaleScansFailed();
  console.log(`[server] Opengrep Studio 后端已启动: http://${config.host}:${config.port}`);
  console.log(`[server] 引擎路径: ${path.resolve(config.opengrepBin)}（${engineSourceLabel()}）`);
  console.log(
    `[server] 运行平台: ${process.platform}/${process.arch}  清单目标引擎版本: ${engineTargetVersion() ?? '未知'}`,
  );
  console.log(`[server] 数据目录: ${config.dataDir}`);
  if (!fs.existsSync(config.opengrepBin)) {
    console.error(`[server] 警告：${engineInstallHint().replace(/\n/g, '\n[server] ')}`);
  }
});

server.on('listening', () => {
  cleanupRuleLabScratch();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] 端口 ${config.port} 已被占用——很可能是另一个正在使用的实例，不要杀它（可能有人在用）。` +
        `换个端口：PORT=${config.port + 1} npm start；确认是残留进程时才执行: node server/scripts/kill-port.mjs ${config.port}`,
    );
    process.exit(1);
  }
  throw err;
});

// 退出时先杀引擎子进程再关 HTTP：Docker stop / taskkill 只把信号发给 node 本身，
// 不处理的话孤儿 opengrep 会继续跑完并占着引擎文件（Windows 上会锁死下一次升级）
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，终止引擎子进程并退出`);
  terminateTrackedChildren();
  server.close(() => process.exit(0));
  // 兜底：个别连接挂着不关也要保证退出
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
