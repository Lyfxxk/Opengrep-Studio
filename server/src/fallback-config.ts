import {
  insertConfig,
  listConfigs,
  listRulePacks,
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

/** 兜底配置的初始规则集：全部启用的内置规则包（与 configs 表的列默认值一致） */
function defaultRulePackIds(): string[] {
  return listRulePacks()
    .filter((pack) => pack.builtin && pack.enabled)
    .map((pack) => pack.id);
}

/**
 * 确保「兜底扫描配置」存在且带受保护标记（服务启动时调用一次，扫描时兜底解析也会再调）。
 *
 * 幂等且尊重既有数据：已有受保护配置直接返回；旧库里存在同名的一键扫描配置则就地接管；
 * 都没有才新建。用户在配置页对它的调整（规则包勾选、超时等）不会被覆盖——只有删除被禁止
 * （见 DELETE /api/configs/:id），因为未绑定配置的项目扫描会回落到它。
 *
 * 没有可用的已启用内置包时返回 undefined，由调用方给出下一步指引。
 */
export function ensureFallbackScanConfig(): ScanConfig | undefined {
  const configs = listConfigs();
  const config = configs.find((item) => item.isProtected);
  if (config) return config;

  const adoptable = configs.find((item) => item.name === FALLBACK_CONFIG_NAME);
  if (adoptable) {
    updateConfig(adoptable.id, { isProtected: true });
    console.log(`[config] 既有「${FALLBACK_CONFIG_NAME}」已设为不可删除的兜底配置（${adoptable.id}）`);
    return { ...adoptable, isProtected: true };
  }

  const rulePackIds = defaultRulePackIds();
  if (rulePackIds.length === 0) return undefined;
  const fallback: ScanConfig = {
    id: FALLBACK_CONFIG_ID,
    name: FALLBACK_CONFIG_NAME,
    description: '兜底配置：未绑定配置（或绑定已失效）的项目扫描时自动使用；可调整但不可删除',
    rulePackIds,
    excludes: [],
    includes: [],
    timeoutSeconds: 5,
    jobs: 4,
    maxTargetBytes: 1000000,
    createdAt: new Date().toISOString(),
    isProtected: true,
  };
  insertConfig(fallback);
  console.log(`[config] 已创建不可删除的兜底配置「${FALLBACK_CONFIG_NAME}」（${fallback.id}）`);
  return fallback;
}
