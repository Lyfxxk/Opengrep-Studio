import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { config, engineSource } from '../config.js';
import { HttpError } from '../errors.js';
import {
  engineAvailable,
  engineDisplayPath,
  engineInstallHint,
  engineNotRunnableHint,
  engineSourceLabel,
  getEngineVersion,
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
import { runRuleLab } from '../rule-lab.js';
import { engineUpgradeRunning } from '../engine-update.js';
import { isEngineJobBusy, setEngineJobBusy } from '../engine-job.js';
import { asyncHandler, MAX_RULE_YAML_BYTES, MAX_SAMPLE_BYTES, newId } from './shared.js';

export const miscRoutes = Router();

miscRoutes.get('/api/health', asyncHandler(async (_req, res) => {
  const engineReady = engineAvailable();
  // 引擎文件存在也可能跑不起来（损坏/被杀软拦截，Windows 同步抛 spawn EFTYPE）：
  // 探测异常必须降级为 undefined 而不是抛出去——health 一旦 500，前端卡片拿不到任何状态，永远停在「加载中」
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
  res.json({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    // 实际探测的版本（引擎缺失或探测失败时为 undefined）；清单钉住的版本单独给出，避免"版本漂移看不出来"
    engineVersion,
    enginePinnedVersion: engineTargetVersion(),
    // 只有安装位引擎能被一键升级：env / PATH 来源交给用户自己管
    engineManaged: engineReady && engineSource === 'bundled-dir',
    engine: engineReady ? engineDisplayPath() : 'MISSING',
    engineSource,
    engineSourceLabel: engineSourceLabel(),
    ...(engineHint ? { engineHint } : {}),
  });
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

miscRoutes.get('/api/messages-zh', serveRuleMessages('messages-zh.json'));
miscRoutes.get('/api/messages-zh-Hant', serveRuleMessages('messages-zh-Hant.json'));

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

miscRoutes.get('/api/configs', (_req, res) => {
  res.json(listConfigs());
});

miscRoutes.post('/api/configs', asyncHandler(async (req, res) => {
  const values = requireValidConfigValues(req.body ?? {});
  const scanConfig: ScanConfig = {
    id: newId('cfg'),
    ...values,
    createdAt: new Date().toISOString(),
  };
  insertConfig(scanConfig);
  res.status(201).json(scanConfig);
}));

miscRoutes.put('/api/configs/:id', asyncHandler(async (req, res) => {
  const existing = getConfig(req.params.id);
  if (!existing) {
    throw new HttpError(404, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
  }
  const values = requireValidConfigValues(req.body ?? {}, existing.id);
  updateConfig(existing.id, values);
  res.json(getConfig(existing.id));
}));

miscRoutes.delete('/api/configs/:id', asyncHandler(async (req, res) => {
  const existing = getConfig(req.params.id);
  if (!existing) {
    throw new HttpError(404, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
  }
  deleteConfig(existing.id);
  res.status(204).end();
}));

// ---------- 规则知识库（P1-5） ----------

miscRoutes.get('/api/rules/knowledge/:ruleId', asyncHandler(async (req, res) => {
  const ruleId = String(req.params.ruleId ?? '').trim();
  if (!ruleId || ruleId.length > 200) {
    throw new HttpError(400, '需要 ruleId 路径参数', { code: 'srv.ruleIdInvalid' });
  }
  // 只认已支持的两种语言：非法值回落简体，避免任意 query 改变读取路径
  const lang = req.query.lang === 'zh-Hant' ? 'zh-Hant' : 'zh';
  res.json(getRuleKnowledge(ruleId, lang));
}));

miscRoutes.post('/api/rulelab/run', asyncHandler(async (req, res) => {
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
  if (isEngineJobBusy()) {
    throw new HttpError(409, '上一次引擎任务（实验室/质量检查）还在运行，请稍候再试', { code: 'srv.engineJobBusy' });
  }
  setEngineJobBusy(true);
  try {
    res.json(await runRuleLab(yaml, samples, language));
  } finally {
    setEngineJobBusy(false);
  }
}));
