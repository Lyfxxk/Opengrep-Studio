import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import AdmZip from 'adm-zip';
import { Router } from 'express';
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
import { isSafeSampleDirName } from '../knowledge.js';
import {
  builtinRulesDir,
  collectRuleFiles,
  customPackDir,
  customPackPath,
  packFilePath,
} from '../rulepacks.js';
import { asRuleFileHttpError, LANG_EXT, parseRuleYaml, runPackCheck, RuleYamlError } from '../rule-lab.js';
import {
  buildLegacyManifestYaml,
  buildPackReadme,
  parsePackManifest,
  scanPackSamples,
  type PackManifest,
} from '../pack-format.js';
import { asyncHandler, decodeUploadFileName, limit400, MAX_RULE_YAML_BYTES, MAX_SAMPLE_BYTES, memoryFileUpload, newId, withEngineJobBusy } from './shared.js';

export const rulepackRoutes = Router();

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

export function pruneStaleBuiltinPacks(): void {
  for (const pack of listRulePacks()) {
    if (pack.builtin && !fs.existsSync(packFilePath(pack))) {
      deleteRulePack(pack.id);
      console.log(`[rulepack] 已清理失效的内置规则包 ${pack.id}`);
    }
  }
}

function requireValidPackName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new HttpError(400, '请输入规则包名称', { code: 'srv.packNameRequired' });
  if (name.length > 50) {
    throw new HttpError(400, '规则包名称不能超过 50 个字符', { code: 'srv.packNameTooLong' });
  }
  return name;
}

function asRuleYamlHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof RuleYamlError) {
    return new HttpError(400, error.message, { code: error.code, params: error.params });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new HttpError(400, reason, { code: 'srv.ruleYamlInvalid', params: { reason } });
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

function savePortablePackFromLab(
  name: string,
  language: string,
  yamlText: string,
  samples: { positive: string; negative: string },
): RulePack {
  const parsed = parseRuleYaml(yamlText);
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
      sampleLanguage
        ? { code: 'srv.sampleLangUnsupported', params: { language: sampleLanguage } }
        : { code: 'srv.ruleLanguageMissing' },
    );
  }
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
  if (content.length > MAX_RULE_YAML_BYTES) {
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
    throw asRuleYamlHttpError(error);
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

const uploadYaml = memoryFileUpload(MAX_RULE_YAML_BYTES, {
  pattern: /\.ya?ml$/i,
  message: '仅支持 .yaml / .yml 规则包文件',
  code: 'srv.yamlOnly',
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
      res.status(201).json(saveNewRulePack(name, language, content, decodeUploadFileName(req.file.originalname)));
    } catch (error) {
      throw asRuleYamlHttpError(error);
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
  if (content.length > MAX_RULE_YAML_BYTES) {
    throw new HttpError(400, `规则 YAML 超过 ${MAX_RULE_YAML_BYTES / 1024 / 1024}MB 上限`, {
      code: 'srv.ruleYamlTooLarge',
      params: { mb: MAX_RULE_YAML_BYTES / 1024 / 1024 },
    });
  }
  let ruleCount: number;
  try {
    ruleCount = parseRuleYaml(content).ruleCount;
  } catch (error) {
    throw asRuleYamlHttpError(error);
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
    const params = error instanceof RuleYamlError
      ? { reasonCode: error.code, ...(error.params ? { reasonParams: error.params } : {}) }
      : { reason };
    throw new HttpError(400, `规则包内容无法解析，导出中止：${reason}`, {
      code: 'srv.packExportParseFailed',
      params,
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

const importPackUpload = memoryFileUpload(MAX_PACK_ZIP_BYTES, {
  pattern: /\.zip$/i,
  message: '仅支持 .zip 规则包压缩包',
  code: 'srv.zipOnly',
});

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

function detectLooseRoot(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile())) return dir;
  const dirs = entries.filter((entry) => entry.isDirectory());
  return dirs.length === 1 ? path.join(dir, dirs[0].name) : dir;
}

async function importPortablePack(root: string, res: Response): Promise<void> {
  let manifest: PackManifest;
  try {
    manifest = parsePackManifest(fs.readFileSync(path.join(root, 'pack.yaml'), 'utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, reason, {
      code: 'srv.packManifestUnparseable',
      params: { reason },
    });
  }
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
        if (ids.has(id)) {
          throw new RuleYamlError('ruleYaml.duplicateId', `存在重复的规则 id：${id}`, { id });
        }
        ids.add(id);
        ruleCount += 1;
      }
    } catch (error) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      throw asRuleFileHttpError(error, rel);
    }
  }
  const { sampleCount } = scanPackSamples(root, ids);
  const packId = newId('rp');
  const destDir = customPackDir(packId);
  fs.mkdirSync(config.customRulesDir, { recursive: true });
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
  try {
    await copyDirectory(root, destDir);
    insertRulePack(pack);
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw error;
  }
  res.status(201).json({
    ...pack,
    message: `导入成功：${ruleCount} 条规则、${sampleCount} 个样本，建议先运行质量检查`,
    messageCode: 'srv.importSuccess',
    messageParams: { rules: ruleCount, samples: sampleCount },
  });
}

async function importLoosePack(
  options: { root: string; zipName: string; originalName: string; nameInput: string; languageInput: string },
  res: Response,
): Promise<void> {
  const looseFiles = fs
    .readdirSync(options.root, { withFileTypes: true })
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
  const content = fs.readFileSync(path.join(options.root, looseFiles[0].name), 'utf8');
  const name = requireValidPackName(options.nameInput || options.zipName);
  let language = options.languageInput;
  try {
    language = language || parseRuleYaml(content).firstLanguage;
  } catch (error) {
    throw asRuleFileHttpError(error, looseFiles[0].name);
  }
  const pack = saveNewRulePack(name, language || 'Other', content, options.originalName);
  res.status(201).json({
    ...pack,
    message: '导入成功（单文件包，无样本，basic 档）',
    messageCode: 'srv.importSuccessBasic',
  });
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
        await importPortablePack(root, res);
        return;
      }
      await importLoosePack(
        {
          root: detectLooseRoot(tmpDir),
          zipName,
          originalName,
          nameInput: String(req.body?.name ?? '').trim(),
          languageInput: String(req.body?.language ?? '').trim(),
        },
        res,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }),
);

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
  const result = await withEngineJobBusy(
    { message: '引擎升级进行中，请升级完成后再做质量检查', code: 'srv.checkUpgradeBusy' },
    () => runPackCheck(customPackDir(pack.id)),
  );
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
}));
