import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { config, engineSource } from '../config.js';
import { HttpError } from '../errors.js';
import {
  checkEngineUpdate,
  engineAvailable,
  engineDisplayPath,
  engineInstallHint,
  engineInstallHintInfo,
  engineNotRunnableHint,
  engineNotRunnableHintInfo,
  engineUpgradeState,
  getEngineVersion,
  startEngineUpgrade,
} from '../engine.js';
import { engineTargetVersion } from '../engine-manifest.js';
import {
  deleteConfig,
  getConfig,
  getRulePack,
  insertConfig,
  listConfigs,
  updateConfig,
  type ScanConfig,
} from '../db.js';
import { getRuleKnowledge } from '../knowledge.js';
import { hasRunningScan, MAX_PATH_FILTER_GLOBSTARS } from '../scan-runner.js';
import { runRuleLab } from '../rule-lab.js';
import { requireRole } from '../auth.js';
import { asyncHandler, isEngineJobBusy, MAX_RULE_YAML_BYTES, MAX_SAMPLE_BYTES, newId, parseProductLang, withEngineJobBusy } from './shared.js';

export const miscRoutes = Router();

const MAX_CONFIG_DESCRIPTION_LENGTH = 200;
const MAX_PATH_FILTER_ENTRIES = 20;
const MAX_PATH_FILTER_LENGTH = 200;

miscRoutes.get('/api/health', asyncHandler(async (_req, res) => {
  const engineReady = engineAvailable();
  let engineVersion: string | undefined;
  if (engineReady) {
    try {
      engineVersion = await getEngineVersion();
    } catch {
      engineVersion = undefined;
    }
  }
  const engineHint = !engineReady
    ? engineInstallHint()
    : engineVersion
      ? undefined
      : engineNotRunnableHint();
  const engineHintInfo = !engineReady
    ? engineInstallHintInfo()
    : engineVersion
      ? undefined
      : engineNotRunnableHintInfo();
  res.json({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    engineVersion,
    enginePinnedVersion: engineTargetVersion(),
    engineManaged: engineReady && engineSource === 'bundled-dir',
    engineReady,
    engine: engineReady ? engineDisplayPath() : 'MISSING',
    engineSource,
    ...(engineHint ? { engineHint } : {}),
    ...(engineHintInfo ? { engineHintCode: engineHintInfo.code, engineHintParams: engineHintInfo.params } : {}),
    ...(engineHintInfo && process.platform === 'darwin' ? { engineHintMacos: true } : {}),
  });
}));

function serveRuleMessages(fileName: string) {
  return (_req: Request, res: Response) => {
    try {
      res.json(JSON.parse(fs.readFileSync(path.join(config.rulesDir, fileName), 'utf8')));
    } catch {
      res.json({});
    }
  };
}

miscRoutes.get('/api/messages-zh', serveRuleMessages('messages-zh.json'));
miscRoutes.get('/api/messages-zh-Hant', serveRuleMessages('messages-zh-Hant.json'));
miscRoutes.get('/api/messages-ja', serveRuleMessages('messages-ja.json'));
miscRoutes.get('/api/messages-ko', serveRuleMessages('messages-ko.json'));

function requireValidConfigValues(body: Record<string, unknown>, existingId?: string) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '配置名称不能为空', { code: 'srv.configNameRequired' });
  if (name.length > 50) throw new HttpError(400, '配置名称不能超过 50 个字符', { code: 'srv.configNameTooLong' });
  const duplicated = listConfigs().some(
    (item) => item.name === name && item.id !== existingId,
  );
  if (duplicated) throw new HttpError(400, '配置名称已存在', { code: 'srv.configNameExists' });

  const description = String(body?.description ?? '').trim();
  if (description.length > MAX_CONFIG_DESCRIPTION_LENGTH) {
    throw new HttpError(400, `配置描述不能超过 ${MAX_CONFIG_DESCRIPTION_LENGTH} 个字符`, {
      code: 'srv.configDescriptionTooLong',
      params: { limit: MAX_CONFIG_DESCRIPTION_LENGTH },
    });
  }

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
  const assertPathFilterLimits = (entries: string[]) => {
    if (entries.length > MAX_PATH_FILTER_ENTRIES) {
      throw new HttpError(400, `路径过滤条目不能超过 ${MAX_PATH_FILTER_ENTRIES} 条`, {
        code: 'srv.pathFiltersTooMany',
        params: { limit: MAX_PATH_FILTER_ENTRIES },
      });
    }
    const tooLong = entries.find((item) => item.length > MAX_PATH_FILTER_LENGTH);
    if (tooLong !== undefined) {
      throw new HttpError(400, `路径过滤条目不能超过 ${MAX_PATH_FILTER_LENGTH} 个字符`, {
        code: 'srv.pathFilterTooLong',
        params: { limit: MAX_PATH_FILTER_LENGTH, item: tooLong },
      });
    }
    const tooManyGlobstars = entries.find(
      (item) => (item.match(/\*\*\//g)?.length ?? 0) > MAX_PATH_FILTER_GLOBSTARS,
    );
    if (tooManyGlobstars !== undefined) {
      throw new HttpError(400, `路径过滤条目最多 ${MAX_PATH_FILTER_GLOBSTARS} 个 **/ 段`, {
        code: 'srv.pathFilterGlobstarsTooMany',
        params: { limit: MAX_PATH_FILTER_GLOBSTARS, item: tooManyGlobstars },
      });
    }
  };
  const assertNoGlobSeparator = (entries: string[]) => {
    const bad = entries.find((item) => /[、，,]/.test(item));
    if (bad !== undefined) {
      throw new HttpError(400, '不能用顿号/逗号分隔多条路径：glob 中这些字符非法，请逐条添加', {
        code: 'srv.globSeparatorInvalid',
        params: { item: bad },
      });
    }
  };
  const excludes = asStringArray(body?.excludes);
  const includes = asStringArray(body?.includes);
  assertPathFilterLimits(excludes);
  assertPathFilterLimits(includes);
  assertNoGlobSeparator(excludes);
  assertNoGlobSeparator(includes);
  const timeoutSeconds = typeof body?.timeoutSeconds === 'number' ? body.timeoutSeconds : NaN;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new HttpError(400, '单文件超时须为 1–600 的整数', { code: 'srv.timeoutInvalid' });
  }
  const jobs = typeof body?.jobs === 'number' ? body.jobs : NaN;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
    throw new HttpError(400, '并发数须为 1–16 的整数', { code: 'srv.jobsInvalid' });
  }
  const maxTargetBytes = typeof body?.maxTargetBytes === 'number' ? body.maxTargetBytes : NaN;
  if (!Number.isInteger(maxTargetBytes) || maxTargetBytes < 100_000 || maxTargetBytes > 100_000_000) {
    throw new HttpError(400, '文件体积上限须在 0.1–100 MB 之间', { code: 'srv.sizeInvalid' });
  }
  return {
    name,
    description: description || undefined,
    rulePackIds: [...new Set(rulePackIds)],
    excludes,
    includes,
    timeoutSeconds,
    jobs,
    maxTargetBytes,
  };
}

miscRoutes.get('/api/configs', (_req, res) => {
  res.json(listConfigs());
});

miscRoutes.post('/api/configs', requireRole('admin'), asyncHandler(async (req, res) => {
  const values = requireValidConfigValues(req.body ?? {});
  const scanConfig: ScanConfig = {
    id: newId('cfg'),
    ...values,
    createdAt: new Date().toISOString(),
  };
  insertConfig(scanConfig);
  res.status(201).json(scanConfig);
}));

miscRoutes.put('/api/configs/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = getConfig(req.params.id);
  if (!existing) {
    throw new HttpError(404, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
  }
  const values = requireValidConfigValues(req.body ?? {}, existing.id);
  updateConfig(existing.id, values);
  res.json(getConfig(existing.id));
}));

miscRoutes.delete('/api/configs/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const existing = getConfig(req.params.id);
  if (!existing) {
    throw new HttpError(404, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
  }
  if (existing.isProtected) {
    throw new HttpError(403, '兜底扫描配置不可删除；没有绑定配置的项目扫描会自动使用它', {
      code: 'srv.configProtected',
    });
  }
  deleteConfig(existing.id);
  res.status(204).end();
}));


miscRoutes.get('/api/rules/knowledge/:ruleId', asyncHandler(async (req, res) => {
  const ruleId = String(req.params.ruleId ?? '').trim();
  if (!ruleId || ruleId.length > 200) {
    throw new HttpError(400, '需要 ruleId 路径参数', { code: 'srv.ruleIdInvalid' });
  }
  const lang = parseProductLang(req.query.lang);
  res.json(getRuleKnowledge(ruleId, lang));
}));

miscRoutes.post('/api/rulelab/run', requireRole('auditor'), asyncHandler(async (req, res) => {
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
  res.json(
    await withEngineJobBusy(
      { message: '引擎升级进行中，请升级完成后再运行实验室', code: 'srv.labUpgradeBusy' },
      () => runRuleLab(yaml, samples, language),
    ),
  );
}));

miscRoutes.get('/api/engine/update', asyncHandler(async (req, res) => {
  res.json(await checkEngineUpdate(req.query.refresh === '1'));
}));

miscRoutes.get('/api/engine/upgrade', (_req, res) => {
  res.json(engineUpgradeState());
});

miscRoutes.post('/api/engine/upgrade', requireRole('admin'), asyncHandler(async (_req, res) => {
  if (hasRunningScan()) {
    throw new HttpError(409, '有扫描任务正在运行，请等扫描结束后再升级引擎', {
      code: 'srv.upgradeScanBusy',
    });
  }
  if (isEngineJobBusy()) {
    throw new HttpError(409, '规则实验室或规则包质量检查正在运行，请稍后再升级引擎', {
      code: 'srv.upgradeJobBusy',
    });
  }
  res.status(202).json(await startEngineUpgrade());
}));
