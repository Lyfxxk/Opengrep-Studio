import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { copyDirectory, extractZipSafely } from '../archive.js';
import { HttpError } from '../errors.js';
import {
  deleteRulePack,
  getRulePack,
  insertRulePack,
  listRulePacks,
  updateRulePack,
  type RulePack,
} from '../db.js';
import { parseRuleYaml } from '../rule-yaml.js';
import { isSafeSampleDirName } from '../knowledge.js';
import {
  builtinRulesDir,
  collectRuleFiles,
  customPackDir,
  customPackPath,
  packFilePath,
} from '../rulepacks.js';
import { LANG_EXT, runPackCheck } from '../rule-lab.js';
import {
  buildLegacyManifestYaml,
  buildPackReadme,
  parsePackManifest,
  scanPackSamples,
  type PackManifest,
} from '../pack-format.js';
import { engineUpgradeRunning } from '../engine-update.js';
import { isEngineJobBusy, setEngineJobBusy } from '../engine-job.js';
import { asyncHandler, decodeUploadFileName, limit400, MAX_RULE_YAML_BYTES, MAX_SAMPLE_BYTES, newId } from './shared.js';

export const rulepackRoutes = Router();

/** 规则包 zip 导入的体积上限（文案从取数点引用） */
const MAX_PACK_ZIP_BYTES = 20 * 1024 * 1024;

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

export function ensureBuiltinRulePacks(): void {
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
export function pruneStaleBuiltinPacks(): void {
  for (const pack of listRulePacks()) {
    if (pack.builtin && !fs.existsSync(packFilePath(pack))) {
      deleteRulePack(pack.id);
      console.log(`[rulepack] 已清理失效的内置规则包 ${pack.id}`);
    }
  }
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

rulepackRoutes.get('/api/rulepacks', (_req, res) => {
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
  // 与实验室 runRuleLab 的前置校验对齐：样本扩展名取自首条规则语言，语言不在 LANG_EXT
  // 表内时若静默跳过落盘，包会以 sampleCount=0 照常创建并返回 201，样本彻底丢失且无提示。
  // 必须在写盘之前拦下，避免留下半成品包目录；文案与实验室保持一致（同语言两条入口同口径）。
  const sampleLanguage = parsed.firstLanguage.trim();
  if (
    (samples.positive.trim() || samples.negative.trim()) &&
    !LANG_EXT[sampleLanguage.toLowerCase()]
  ) {
    throw new HttpError(
      400,
      sampleLanguage
        ? `暂不支持为语言 ${sampleLanguage} 提供测试样本`
        : '无法从规则推断语言，请在第一条规则的 languages 中填写',
    );
  }
  // 规则 id 来自 YAML（不受信输入），落盘前必须确保可作单级样本目录名，否则会写出 customRulesDir
  if (parsed.ruleIds[0] && !isSafeSampleDirName(parsed.ruleIds[0])) {
    throw new HttpError(
      400,
      `首个规则 id「${parsed.ruleIds[0]}」含不安全字符，无法作为样本目录名；请修改 YAML 中的规则 id 后重试`,
      { code: 'srv.ruleIdUnsafe', params: { id: parsed.ruleIds[0] } },
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

rulepackRoutes.post('/api/rulepacks', asyncHandler(async (req, res) => {
  if (req.is('multipart/form-data')) {
    res.status(400).json({
      error: { message: '文件上传请使用 /api/rulepacks/upload', code: 'srv.uploadEndpointMismatch' },
    });
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
    // savePortablePackFromLab 抛的 HttpError 自带 code/params（如 srv.ruleIdUnsafe），
    // 重新包装会丢掉契约键，前端就只能显示中文兜底文案
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}));

rulepackRoutes.patch('/api/rulepacks/:id', asyncHandler(async (req, res) => {
  const pack = getRulePack(req.params.id);
  if (!pack) throw new HttpError(404, '规则包不存在或已被删除', { code: 'srv.packNotFound' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    throw new HttpError(400, '需要 enabled 布尔字段', { code: 'srv.enabledRequired' });
  }
  updateRulePack(pack.id, { enabled });
  res.json({ ...pack, enabled });
}));

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

rulepackRoutes.post(
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
      // 上传来源只用于日志；中文文件名按 UTF-8 还原，否则日志里是一串 latin1 乱码
      res.status(201).json(saveNewRulePack(name, language, content, decodeUploadFileName(req.file.originalname)));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }),
);

rulepackRoutes.get('/api/rulepacks/:id/content', asyncHandler(async (req, res) => {
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

rulepackRoutes.put('/api/rulepacks/:id/content', asyncHandler(async (req, res) => {
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
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  fs.writeFileSync(customPackPath(pack.id), content, 'utf8');
  updateRulePack(pack.id, { ruleCount });
  res.json({ ...pack, ruleCount });
}));

rulepackRoutes.delete('/api/rulepacks/:id', asyncHandler(async (req, res) => {
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `规则包内容无法解析，导出中止：${reason}`, {
      code: 'srv.packExportParseFailed',
      params: { reason },
    });
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
rulepackRoutes.get('/api/rulepacks/:id/export', asyncHandler(async (req, res) => {
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

rulepackRoutes.post(
  '/api/rulepacks/import',
  limit400(importPackUpload.single('file'), MAX_PACK_ZIP_BYTES),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, '请通过 multipart 表单上传 file 字段（.zip）', {
        code: 'srv.fileRequired',
      });
    }
    const originalName = decodeUploadFileName(req.file.originalname);
    const zipName = originalName.replace(/\.zip$/i, '');
    const tmpDir = path.join(os.tmpdir(), `ogpack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await extractZipSafely(req.file.buffer, tmpDir);
      const root = detectPackRoot(tmpDir);

      if (root) {
        // 可移植格式：pack.yaml + rules/ + samples/
        let manifest: PackManifest;
        try {
          manifest = parsePackManifest(fs.readFileSync(path.join(root, 'pack.yaml'), 'utf8'));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        // 缺 rules/ 目录（ENOENT）、或 rules 是普通文件（ENOTDIR）时 readdirSync 都会抛错落成 500，
        // 先用 stat 一次拦成 400（collectRuleFiles 还有导出等调用点，不在其内部兜底）
        const rulesStat = fs.statSync(path.join(root, 'rules'), { throwIfNoEntry: false });
        if (!rulesStat?.isDirectory()) {
          throw new HttpError(400, '包内缺少 rules/ 目录：请按 pack.yaml + rules/ + samples/ 结构打包', {
            code: 'srv.noRulesDir',
          });
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
            const reason = error instanceof Error ? error.message : String(error);
            throw new HttpError(400, `规则文件 ${rel} 不合法：${reason}`, {
              code: 'srv.ruleFileInvalidDetail',
              params: { name: rel, reason },
            });
          }
        }
        const { sampleCount } = scanPackSamples(root, ids);
        const packId = newId('rp');
        const destDir = customPackDir(packId);
        fs.mkdirSync(config.customRulesDir, { recursive: true });
        // zip 顶层文件夹名不可控（可能含中文），必须用安全复制（见 copyDirectory 注释）
        try {
          await copyDirectory(root, destDir);
        } catch (error) {
          // 复制中途失败（磁盘满/超长文件名/杀软拦截）会把半成品残留在 customRulesDir：
          // 记录尚未落库，只有启动漂移警告能看到它，直接清掉（与 finally 清 tmpDir 同口径）
          fs.rmSync(destDir, { recursive: true, force: true });
          throw error;
        }
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
          { code: 'srv.packManifestMissing' },
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
      const pack = saveNewRulePack(name, language || 'Other', content, originalName);
      res.status(201).json({ ...pack, message: '导入成功（单文件包，无样本，basic 档）' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }),
);

/** 规则包质量检查：逐规则跑自己的正反例样本（复用实验室 runner），结果存为 lastCheck */
rulepackRoutes.post('/api/rulepacks/:id/check', asyncHandler(async (req, res) => {
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
  if (isEngineJobBusy()) {
    throw new HttpError(409, '上一次引擎任务（实验室/质量检查）还在运行，请稍候再试', { code: 'srv.engineJobBusy' });
  }
  setEngineJobBusy(true);
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
    setEngineJobBusy(false);
  }
}));
