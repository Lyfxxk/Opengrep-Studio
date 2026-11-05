import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.resolve(here, '..', 'rules');
const securityDir = path.join(rulesDir, 'security');
const distDir = path.resolve(here, '..', '..', 'site', 'dist');
const expectedRuleCount = 812;

const asStringArray = (value) =>
  typeof value === 'string'
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean)
      : [];

const normalizeCweId = (raw) => {
  const match = String(raw).match(/CWE-0*(\d+)/i);
  return match ? `CWE-${match[1]}` : String(raw).trim();
};

const cweNumber = (id) => {
  const match = id.match(/^CWE-0*(\d+)$/i);
  return match ? match[1] : id;
};

const formatSize = (bytes) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(2)} MB` : `${Math.round(bytes / 1000)} KB`;

const listDictLangs = (prefix) =>
  fs
    .readdirSync(rulesDir)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.json'))
    .map((name) => name.slice(prefix.length + 1, -'.json'.length))
    .sort();

function readDictionaries(prefix) {
  const langs = listDictLangs(prefix);
  const dicts = {};
  const errors = [];
  for (const lang of langs) {
    try {
      dicts[lang] = JSON.parse(fs.readFileSync(path.join(rulesDir, `${prefix}-${lang}.json`), 'utf8'));
    } catch (error) {
      errors.push(`${prefix}-${lang}.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { langs, dicts, errors };
}

function collectRules() {
  const packs = [];
  const items = [];
  const errors = [];
  const idCounts = new Map();
  if (!fs.existsSync(securityDir)) {
    errors.push(`缺少 ${securityDir}，请确认仓库结构完整`);
    return { packs, items, errors, idCounts };
  }
  const files = fs
    .readdirSync(securityDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of files) {
    let doc;
    try {
      doc = yamlLoad(fs.readFileSync(path.join(securityDir, name), 'utf8'));
    } catch (error) {
      errors.push(`security/${name} YAML 解析失败：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const list = Array.isArray(doc?.rules) ? doc.rules : null;
    if (!list || list.length === 0) {
      errors.push(`security/${name} 缺少非空的 rules 列表`);
      continue;
    }
    const packId = name.replace(/\.ya?ml$/i, '');
    packs.push({ id: packId, ruleCount: list.length });
    for (const [index, rule] of list.entries()) {
      const id = typeof rule?.id === 'string' ? rule.id.trim() : '';
      if (!id) {
        errors.push(`security/${name} 第 ${index + 1} 条规则缺少 id`);
        continue;
      }
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      items.push({ id, pack: packId, rule });
    }
  }
  return { packs, items, errors, idCounts };
}

function buildEntry(item, messageDicts) {
  const { id, pack, rule } = item;
  const metadata = typeof rule.metadata === 'object' && rule.metadata !== null ? rule.metadata : {};
  const entry = {
    id,
    pack,
    ...(typeof rule.message === 'string' && rule.message.trim() ? { message: rule.message } : {}),
    ...(asStringArray(rule.languages).length ? { languages: asStringArray(rule.languages) } : {}),
    ...(typeof rule.severity === 'string' && rule.severity.trim() ? { severity: rule.severity } : {}),
  };
  const cwe = [...new Set(asStringArray(metadata.cwe).map(normalizeCweId))];
  const owasp = asStringArray(metadata.owasp);
  if (cwe.length) entry.cwe = cwe;
  if (owasp.length) entry.owasp = owasp;
  for (const key of ['likelihood', 'impact', 'confidence']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) entry[key] = value.trim();
  }
  const upstream = typeof metadata['opengrep-studio'] === 'object' && metadata['opengrep-studio'] !== null
    ? metadata['opengrep-studio']
    : {};
  const upstreamPath =
    typeof upstream['upstream-path'] === 'string' ? upstream['upstream-path'].trim().replace(/^\/+/, '') : '';
  if (upstreamPath) entry.upstreamPath = upstreamPath;
  const descriptions = {};
  for (const [lang, dict] of Object.entries(messageDicts)) {
    const text = dict?.[id];
    if (typeof text === 'string' && text.trim()) descriptions[lang] = text;
  }
  entry.descriptions = descriptions;
  return { entry, cwe };
}

function validate(collected, messages, cwe) {
  const problems = [];
  problems.push(...collected.errors, ...messages.errors, ...cwe.errors);

  const duplicates = [...collected.idCounts.entries()].filter(([, count]) => count > 1);
  if (duplicates.length) {
    problems.push(`规则 id 重复 ${duplicates.length} 个：${duplicates.slice(0, 5).map(([id]) => id).join('、')}`);
  }

  if (collected.items.length !== expectedRuleCount) {
    problems.push(
      `规则数应为 ${expectedRuleCount}，实际 ${collected.items.length}；规则集变化时请同步更新本脚本的 expectedRuleCount 与全部 messages-*.json / cwe-*.json 词典`,
    );
  }

  const dictChecks = [
    ['messages', messages, (lang, missing, extra) => {
      if (missing.length) problems.push(`messages-${lang} 相对 messages-${messages.base} 缺少 ${missing.length} 条：${missing.slice(0, 5).join('、')}`);
      if (extra.length) problems.push(`messages-${lang} 相对 messages-${messages.base} 多出 ${extra.length} 条：${extra.slice(0, 5).join('、')}`);
    }],
    ['cwe', cwe, (lang, missing, extra) => {
      if (missing.length) problems.push(`cwe-${lang} 相对 cwe-${cwe.base} 缺少 ${missing.length} 条：${missing.slice(0, 5).join('、')}`);
      if (extra.length) problems.push(`cwe-${lang} 相对 cwe-${cwe.base} 多出 ${extra.length} 条：${extra.slice(0, 5).join('、')}`);
    }],
  ];
  for (const [, resource] of dictChecks) {
    resource.base = 'zh' in resource.dicts ? 'zh' : resource.langs[0];
  }
  for (const [, resource, report] of dictChecks) {
    const baseKeys = new Set(Object.keys(resource.dicts[resource.base] ?? {}));
    for (const lang of resource.langs) {
      if (lang === resource.base) continue;
      const keys = new Set(Object.keys(resource.dicts[lang] ?? {}));
      report(lang, [...baseKeys].filter((key) => !keys.has(key)), [...keys].filter((key) => !baseKeys.has(key)));
    }
  }

  for (const lang of messages.langs) {
    const dict = messages.dicts[lang] ?? {};
    const missing = collected.items
      .filter((item) => {
        const text = dict[item.id];
        return typeof text !== 'string' || !text.trim();
      })
      .map((item) => item.id);
    if (missing.length) {
      problems.push(`messages-${lang} 缺少 ${missing.length} 条规则说明：${missing.slice(0, 5).join('、')}`);
    }
  }

  const refs = new Set();
  for (const item of collected.items) {
    const metadata = typeof item.rule.metadata === 'object' && item.rule.metadata !== null ? item.rule.metadata : {};
    for (const id of asStringArray(metadata.cwe).map(normalizeCweId)) refs.add(id);
  }
  const cweBase = cwe.dicts[cwe.base] ?? {};
  const unresolved = [...refs].filter((id) => {
    const hit = cweBase[cweNumber(id)];
    return !hit || typeof hit !== 'object';
  });
  if (unresolved.length) {
    problems.push(`规则引用了 ${unresolved.length} 个 CWE 词典中不存在的编号：${unresolved.slice(0, 5).join('、')}`);
  }

  for (const lang of cwe.langs) {
    const dict = cwe.dicts[lang] ?? {};
    const malformed = Object.entries(dict)
      .filter(([, value]) => typeof value !== 'object' || value === null)
      .map(([key]) => key);
    if (malformed.length) {
      problems.push(`cwe-${lang} 有 ${malformed.length} 条不是对象：${malformed.slice(0, 5).join('、')}`);
    }
  }

  return problems;
}

function printStats({ collected, messages, cwe }) {
  console.log(`[build-rules-site] 规则：${collected.packs.length} 个 YAML 包 / ${collected.items.length} 条规则`);
  console.log(`[build-rules-site]   ${collected.packs.map((pack) => `${pack.id} ${pack.ruleCount}`).join(' · ')}`);
  console.log(
    `[build-rules-site] 规则说明语言（${messages.langs.length}）：${messages.langs.map((lang) => `${lang}=${Object.keys(messages.dicts[lang] ?? {}).length}`).join(' ')}`,
  );
  console.log(
    `[build-rules-site] CWE 词典语言（${cwe.langs.length}）：${cwe.langs.map((lang) => `${lang}=${Object.keys(cwe.dicts[lang] ?? {}).length}`).join(' ')}`,
  );
}

function buildDataset(collected, messages, cwe) {
  const now = new Date().toISOString();
  const rules = [];
  const entries = [];
  for (const item of collected.items) {
    const { entry, cwe: refs } = buildEntry(item, messages.dicts);
    rules.push(entry);
    const searchParts = [entry.id, entry.pack, entry.message ?? ''];
    for (const text of Object.values(entry.descriptions)) searchParts.push(text);
    for (const id of refs) {
      searchParts.push(id, `CWE-${cweNumber(id)}`);
      for (const lang of cwe.langs) {
        const info = cwe.dicts[lang]?.[cweNumber(id)];
        if (info && typeof info.name === 'string') searchParts.push(info.name);
      }
    }
    for (const text of entry.owasp ?? []) searchParts.push(text);
    entries.push({
      id: entry.id,
      pack: entry.pack,
      ...(entry.message ? { message: entry.message } : {}),
      search: [...new Set(searchParts.filter(Boolean))].join(' ').replace(/\s+/g, ' ').toLowerCase(),
    });
  }
  const cweData = {};
  for (const lang of cwe.langs) {
    cweData[lang] = Object.fromEntries(
      Object.entries(cwe.dicts[lang] ?? {})
        .filter(([, value]) => typeof value === 'object' && value !== null)
        .map(([key, value]) => [key, { name: typeof value.name === 'string' ? value.name : '', fix: typeof value.fix === 'string' ? value.fix : '' }]),
    );
  }
  const data = {
    generatedAt: now,
    ruleCount: rules.length,
    languages: messages.langs,
    packs: collected.packs,
    rules,
    cwe: cweData,
  };
  const searchIndex = {
    generatedAt: now,
    ruleCount: entries.length,
    entries,
  };
  return { data, searchIndex };
}

const collected = collectRules();
const messages = readDictionaries('messages');
const cwe = readDictionaries('cwe');
const problems = validate(collected, messages, cwe);
printStats({ collected, messages, cwe });

const check = process.argv.includes('--check');
if (problems.length) {
  console.error(`\n[build-rules-site] 发现 ${problems.length} 个数据问题：`);
  for (const line of problems) console.error(`- ${line}`);
  console.error(
    check
      ? '[build-rules-site] 校验未通过；请修复上方条目后重跑 node server/scripts/build-rules-site.mjs --check（规则说明/CWE 缺键可参考 npm run i18n:check 的口径同步五份词典）'
      : '[build-rules-site] 已取消生成 site/dist；请先修复上方条目再重跑',
  );
  process.exit(1);
}

console.log('[build-rules-site] 校验全部通过 ✔');

if (check) {
  process.exit(0);
}

const { data, searchIndex } = buildDataset(collected, messages, cwe);
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'data.json'), JSON.stringify(data));
fs.writeFileSync(path.join(distDir, 'search-index.json'), JSON.stringify(searchIndex));
console.log(`[build-rules-site] 已生成 site/dist/data.json（${formatSize(fs.statSync(path.join(distDir, 'data.json')).size)}）`);
console.log(`[build-rules-site] 已生成 site/dist/search-index.json（${formatSize(fs.statSync(path.join(distDir, 'search-index.json')).size)}）`);
