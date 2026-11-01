import {
  getConfig,
  insertConfig,
  listConfigs,
  listRulePacks,
  setConfigProtected,
  updateConfig,
  type ScanConfig,
} from './db.js';

const FALLBACK_CONFIG_ID = 'cfg-fallback';
const FALLBACK_CONFIG_NAME = '默认扫描配置';
const FALLBACK_DESCRIPTION =
  '兜底配置：未绑定配置（或绑定已失效）的项目扫描时自动使用；可调整但不可删除';
const LEGACY_AUTO_CREATED_DESCRIPTION = '一键扫描自动创建：全部启用的内置规则包，可在扫描配置页调整';

function defaultRulePackIds(): string[] {
  return listRulePacks()
    .filter((pack) => pack.builtin && pack.enabled)
    .map((pack) => pack.id);
}

function usableRulePackIds(config: ScanConfig): string[] {
  const packs = listRulePacks();
  return config.rulePackIds.filter((id) => {
    const pack = packs.find((item) => item.id === id);
    return pack !== undefined && pack.enabled;
  });
}

function healEmptyRulePacks(config: ScanConfig): ScanConfig {
  if (usableRulePackIds(config).length > 0) return config;
  const rulePackIds = defaultRulePackIds();
  if (rulePackIds.length === 0) return config;
  updateConfig(config.id, { rulePackIds });
  console.log(
    `[config] 兜底配置「${config.name}」的规则包已全部不可用，自动补回 ${rulePackIds.length} 个内置规则包`,
  );
  return { ...config, rulePackIds };
}

export function ensureFallbackScanConfig(): ScanConfig | undefined {
  const configs = listConfigs();
  const protectedConfig = configs.find((config) => config.isProtected);
  if (protectedConfig) return healEmptyRulePacks(protectedConfig);

  const adoptable = configs.find((config) => config.name === FALLBACK_CONFIG_NAME);
  if (adoptable) {
    setConfigProtected(adoptable.id);
    const keepOwnDescription =
      adoptable.description && adoptable.description !== LEGACY_AUTO_CREATED_DESCRIPTION;
    const description = keepOwnDescription ? adoptable.description : FALLBACK_DESCRIPTION;
    if (description !== adoptable.description) updateConfig(adoptable.id, { description });
    console.log(`[config] 既有「${FALLBACK_CONFIG_NAME}」已设为不可删除的兜底配置（${adoptable.id}）`);
    return healEmptyRulePacks({ ...adoptable, isProtected: true, description });
  }

  const rulePackIds = defaultRulePackIds();
  if (rulePackIds.length === 0) return undefined;
  const fallback: ScanConfig = {
    id: FALLBACK_CONFIG_ID,
    name: FALLBACK_CONFIG_NAME,
    description: FALLBACK_DESCRIPTION,
    rulePackIds,
    excludes: [],
    includes: [],
    timeoutSeconds: 5,
    jobs: 4,
    maxTargetBytes: 1000000,
    createdAt: new Date().toISOString(),
    isProtected: true,
  };
  try {
    insertConfig(fallback);
  } catch (error) {
    const rival = getConfig(FALLBACK_CONFIG_ID) ?? listConfigs().find((c) => c.isProtected);
    if (rival) {
      console.log(`[config] 兜底配置已由其他实例创建，复用 ${rival.id}`);
      return healEmptyRulePacks(rival);
    }
    throw error;
  }
  console.log(`[config] 已创建不可删除的兜底配置「${FALLBACK_CONFIG_NAME}」（${fallback.id}）`);
  return fallback;
}
