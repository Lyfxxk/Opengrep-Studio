import {
  getConfig,
  insertConfig,
  listConfigs,
  listRulePacks,
  setConfigProtected,
  updateConfig,
  type ScanConfig,
} from './db.js';

/**
 * 兜底扫描配置的稳定 ID 与名称。
 * 新库直接用这个 ID 创建；旧库里已经有一键扫描自动建的「默认扫描配置」时，就地接管它
 * （只打受保护标记，不改主键，避免出现两份同名配置）。
 */
const FALLBACK_CONFIG_ID = 'cfg-fallback';
const FALLBACK_CONFIG_NAME = '默认扫描配置';
const FALLBACK_DESCRIPTION =
  '兜底配置：未绑定配置（或绑定已失效）的项目扫描时自动使用；可调整但不可删除';
/** 旧版一键扫描自动建配置时写的机器文案，接管时替换掉；用户自己填的说明保留 */
const LEGACY_AUTO_CREATED_DESCRIPTION = '一键扫描自动创建：全部启用的内置规则包，可在扫描配置页调整';

/** 兜底配置的初始规则集：全部启用的内置规则包（与 configs 表的列默认值一致） */
function defaultRulePackIds(): string[] {
  return listRulePacks()
    .filter((pack) => pack.builtin && pack.enabled)
    .map((pack) => pack.id);
}

/** 配置里现在还能真正参与扫描的规则包（被删掉的、停用的一律不算） */
function usableRulePackIds(config: ScanConfig): string[] {
  const packs = listRulePacks();
  return config.rulePackIds.filter((id) => {
    const pack = packs.find((item) => item.id === id);
    return pack !== undefined && pack.enabled;
  });
}

/**
 * 兜底配置被掏空时补齐（自愈）。
 * 删除规则包（deleteRulePack）和清理消失的内置包都会把它的规则集一格格减空，而未绑定配置的项目
 * 只会回落到它——空规则集让这些项目一律卡在 srv.configNoPacks，且没有任何自助恢复入口。
 * 没有可用内置包时原样返回，由调用方给出下一步指引。
 */
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

/**
 * 确保「兜底扫描配置」存在且带受保护标记（服务启动时调用一次，扫描时兜底解析也会再调）。
 *
 * 幂等且尊重既有数据：已有受保护配置直接复用；旧库里存在同名的一键扫描配置则就地接管；
 * 都没有才新建。用户在配置页对它的调整（超时、勾选等）不会被覆盖——只有规则集被掏空时补齐，
 * 删除则一律禁止（见 DELETE /api/configs/:id），因为未绑定配置的项目扫描会回落到它。
 *
 * 没有可用的已启用内置包时返回 undefined，由调用方给出下一步指引。
 */
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
    // 两个实例共用同一个 DATA_DIR 时可能同时建：另一方已建好就直接复用它，别让启动崩掉
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
