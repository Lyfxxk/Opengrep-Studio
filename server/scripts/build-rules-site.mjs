import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.resolve(here, '..', 'rules');
const securityDir = path.join(rulesDir, 'security');
const distDir = path.resolve(here, '..', '..', 'site', 'dist');
const expectedRuleCount = 812;
const upstreamBase = 'https://github.com/opengrep/opengrep-rules/tree/main/';

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

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        errors.push(`security/${name} 规则 id 含不安全字符，无法生成详情页文件名：${id}`);
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
  entry.hasFix = rule.fix != null && (typeof rule.fix === 'string' ? Boolean(rule.fix.trim()) : true);
  const fixRegex = rule['fix-regex'];
  entry.hasFixRegex =
    fixRegex != null && (typeof fixRegex === 'string' ? Boolean(fixRegex.trim()) : Object.keys(fixRegex).length > 0);
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

const SITE_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: #f8fafc; color: #0f172a; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; font-size: 14px; line-height: 1.55; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 56px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 20px; word-break: break-all; }
.head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.navlink { color: #2563eb; text-decoration: none; font-size: 13px; }
.navlink:hover { text-decoration: underline; }
.crumbs { margin: 4px 0 0; font-size: 12px; }
.crumbs a { color: #2563eb; text-decoration: none; }
.crumbs a:hover { text-decoration: underline; }
#lang { padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; font: inherit; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0; }
.stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; }
.stat .v { font-size: 20px; font-weight: 700; }
.stat .k { color: #64748b; font-size: 12px; margin-top: 2px; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 8px; }
.filters input[type='search'] { flex: 1 1 240px; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; background: #fff; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #475569; }
.field select { padding: 7px 8px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; background: #fff; max-width: 280px; }
.count { color: #64748b; font-size: 13px; margin: 10px 2px; }
.count.error { color: #b91c1c; }
.rules { list-style: none; margin: 0; padding: 0; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; overflow: hidden; }
.rules li { padding: 12px 14px; border-top: 1px solid #eef2f7; }
.rules li:first-child { border-top: 0; }
.rules li:hover { background: #f8fafc; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.head code { font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; font-size: 13px; font-weight: 600; word-break: break-all; }
a.rule-link { color: inherit; text-decoration: none; }
a.rule-link:hover code { color: #2563eb; text-decoration: underline; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 0; cursor: default; font-family: inherit; text-decoration: none; }
.chip.pack { background: #f1f5f9; color: #475569; }
.chip.sev.sev-error { background: #fee2e2; color: #b91c1c; }
.chip.sev.sev-warning { background: #fef3c7; color: #92400e; }
.chip.sev.sev-info { background: #dbeafe; color: #1d4ed8; }
.chip.sev.sev-other { background: #e5e7eb; color: #374151; }
.chip.cwe { background: #eff6ff; color: #1e40af; cursor: pointer; }
.chip.cwe:hover { background: #dbeafe; }
.badge-yes { background: #dcfce7; color: #15803d; }
.badge-no { background: #f1f5f9; color: #94a3b8; }
.msg { margin: 6px 0 0; color: #334155; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cwes { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.footer { margin-top: 18px; color: #94a3b8; font-size: 12px; }
.sub { color: #64748b; font-size: 12px; margin: 2px 0 0; }
.detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 14px 0 2px; }
.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; margin: 14px 0; }
.card h2 { font-size: 15px; margin: 0 0 10px; }
.lang-table { width: 100%; border-collapse: collapse; }
.lang-table th, .lang-table td { text-align: left; padding: 8px 10px; border-top: 1px solid #eef2f7; vertical-align: top; }
.lang-table thead th { border-top: 0; color: #64748b; font-size: 12px; font-weight: 600; }
.lang-table tbody th { color: #64748b; font-size: 12px; font-weight: 600; white-space: nowrap; width: 96px; }
.msg-text { margin: 0; white-space: pre-wrap; word-break: break-word; }
.kv { display: flex; align-items: center; gap: 10px; padding: 6px 0; flex-wrap: wrap; }
.kv .k { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: #475569; min-width: 110px; }
.cwe-card + .cwe-card { margin-top: 14px; }
.upstream-link { color: #2563eb; text-decoration: none; word-break: break-all; font-size: 13px; }
.upstream-link:hover { text-decoration: underline; }
.related { list-style: none; margin: 0; padding: 0; }
.related li { padding: 8px 0; border-top: 1px solid #eef2f7; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.related li:first-child { border-top: 0; }
.related a { color: #2563eb; text-decoration: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; font-weight: 600; word-break: break-all; }
.related a:hover { text-decoration: underline; }
.muted { color: #94a3b8; }
@media (max-width: 640px) {
  .wrap { padding: 16px 10px 40px; }
  .lang-table th, .lang-table td { padding: 6px; }
  .lang-table tbody th { width: 64px; }
  .stat .v { font-size: 17px; }
  .kv .k { min-width: 90px; }
}
`;

const SITE_I18N = {
  zh: {
    title: 'Opengrep Studio 规则百科',
    statsRules: '规则总数',
    statsPacks: '规则包',
    statsLangs: '界面语言',
    statsCwe: 'CWE 覆盖',
    searchPlaceholder: '搜索规则 ID、说明、CWE、OWASP…',
    filterPack: '语言包',
    filterSeverity: '严重级',
    filterCwe: 'CWE',
    allOption: '全部',
    showing: '显示 {shown} / {total} 条规则',
    noMatch: '没有匹配的规则，请调整筛选条件',
    loadError: '数据加载失败：请用静态服务器打开本页，并确认同目录存在 data.json 与 search-index.json',
    noDescription: '暂无说明',
    updated: '数据生成于 {time} · Opengrep Studio',
    backHome: '返回列表',
    cweIndexLink: 'CWE 索引',
    secMessages: '各语言消息对照',
    secCwe: 'CWE 知识卡',
    secOwasp: 'OWASP',
    secMeta: '元数据',
    secFix: '修复字段',
    secRelated: '关联规则',
    thLang: '语言',
    thDesc: '消息',
    thName: '名称',
    thFix: '修复建议',
    thRules: '规则数',
    yesBadge: '有',
    noBadge: '无',
    upstreamLabel: '上游规则源',
    noRelated: '暂无规则引用此 CWE',
    subRule: '规则详情',
    subCwe: 'CWE 详情',
  },
  en: {
    title: 'Opengrep Studio Rule Wiki',
    statsRules: 'Total rules',
    statsPacks: 'Rule packs',
    statsLangs: 'Interface language',
    statsCwe: 'CWE coverage',
    searchPlaceholder: 'Search rule ID, description, CWE, OWASP…',
    filterPack: 'Rule pack',
    filterSeverity: 'Severity',
    filterCwe: 'CWE',
    allOption: 'All',
    showing: 'Showing {shown} / {total} rules',
    noMatch: 'No matching rules. Adjust the filters',
    loadError: 'Failed to load data. Open this page via a static server with data.json and search-index.json in the same directory',
    noDescription: 'No description',
    updated: 'Data generated {time} · Opengrep Studio',
    backHome: 'Back to list',
    cweIndexLink: 'CWE index',
    secMessages: 'Messages in all languages',
    secCwe: 'CWE knowledge card',
    secOwasp: 'OWASP',
    secMeta: 'Metadata',
    secFix: 'Fix fields',
    secRelated: 'Related rules',
    thLang: 'Language',
    thDesc: 'Message',
    thName: 'Name',
    thFix: 'Suggested fix',
    thRules: 'Rules',
    yesBadge: 'yes',
    noBadge: 'no',
    upstreamLabel: 'Upstream rule source',
    noRelated: 'No rules reference this CWE',
    subRule: 'Rule details',
    subCwe: 'CWE details',
  },
  'zh-Hant': {
    title: 'Opengrep Studio 規則百科',
    statsRules: '規則總數',
    statsPacks: '規則包',
    statsLangs: '介面語言',
    statsCwe: 'CWE 覆蓋',
    searchPlaceholder: '搜尋規則 ID、說明、CWE、OWASP…',
    filterPack: '語言包',
    filterSeverity: '嚴重度',
    filterCwe: 'CWE',
    allOption: '全部',
    showing: '顯示 {shown} / {total} 條規則',
    noMatch: '沒有符合的規則，請調整篩選條件',
    loadError: '資料載入失敗：請用靜態伺服器開啟本頁，並確認同目錄存在 data.json 與 search-index.json',
    noDescription: '暫無說明',
    updated: '資料產生於 {time} · Opengrep Studio',
    backHome: '返回清單',
    cweIndexLink: 'CWE 索引',
    secMessages: '各語言訊息對照',
    secCwe: 'CWE 知識卡',
    secOwasp: 'OWASP',
    secMeta: '中繼資料',
    secFix: '修復欄位',
    secRelated: '關聯規則',
    thLang: '語言',
    thDesc: '訊息',
    thName: '名稱',
    thFix: '修復建議',
    thRules: '規則數',
    yesBadge: '有',
    noBadge: '無',
    upstreamLabel: '上游規則來源',
    noRelated: '尚無規則引用此 CWE',
    subRule: '規則詳情',
    subCwe: 'CWE 詳情',
  },
  ja: {
    title: 'Opengrep Studio ルール百科',
    statsRules: 'ルール総数',
    statsPacks: 'ルールパック',
    statsLangs: '表示言語',
    statsCwe: 'CWE カバレッジ',
    searchPlaceholder: 'ルール ID・説明・CWE・OWASP を検索',
    filterPack: 'ルールパック',
    filterSeverity: '重要度',
    filterCwe: 'CWE',
    allOption: 'すべて',
    showing: '{total} 件中 {shown} 件を表示',
    noMatch: '該当するルールがありません。条件を変更してください',
    loadError: 'データの読み込みに失敗しました。data.json と search-index.json が同じ場所にある状態で静的サーバーから開いてください',
    noDescription: '説明なし',
    updated: 'データ生成日 {time} · Opengrep Studio',
    backHome: '一覧に戻る',
    cweIndexLink: 'CWE 索引',
    secMessages: '各言語メッセージ対照',
    secCwe: 'CWE ナレッジカード',
    secOwasp: 'OWASP',
    secMeta: 'メタデータ',
    secFix: '修正フィールド',
    secRelated: '関連ルール',
    thLang: '言語',
    thDesc: 'メッセージ',
    thName: '名称',
    thFix: '修正案',
    thRules: 'ルール数',
    yesBadge: 'あり',
    noBadge: 'なし',
    upstreamLabel: '上流ルールソース',
    noRelated: 'この CWE を参照するルールはありません',
    subRule: 'ルール詳細',
    subCwe: 'CWE 詳細',
  },
  ko: {
    title: 'Opengrep Studio 규칙 백과',
    statsRules: '규칙 총수',
    statsPacks: '규칙 팩',
    statsLangs: '인터페이스 언어',
    statsCwe: 'CWE 커버리지',
    searchPlaceholder: '규칙 ID·설명·CWE·OWASP 검색',
    filterPack: '규칙 팩',
    filterSeverity: '심각도',
    filterCwe: 'CWE',
    allOption: '전체',
    showing: '전체 {total}개 중 {shown}개 표시',
    noMatch: '일치하는 규칙이 없습니다. 조건을 조정해 주세요',
    loadError: '데이터를 불러오지 못했습니다. data.json과 search-index.json이 있는 디렉터리를 정적 서버로 열어 주세요',
    noDescription: '설명 없음',
    updated: '데이터 생성일 {time} · Opengrep Studio',
    backHome: '목록으로 돌아가기',
    cweIndexLink: 'CWE 색인',
    secMessages: '언어별 메시지 대조',
    secCwe: 'CWE 지식 카드',
    secOwasp: 'OWASP',
    secMeta: '메타데이터',
    secFix: '수정 필드',
    secRelated: '연관 규칙',
    thLang: '언어',
    thDesc: '메시지',
    thName: '이름',
    thFix: '수정 제안',
    thRules: '규칙 수',
    yesBadge: '있음',
    noBadge: '없음',
    upstreamLabel: '상류 규칙 출처',
    noRelated: '이 CWE를 참조하는 규칙이 없습니다',
    subRule: '규칙 상세',
    subCwe: 'CWE 상세',
  },
  de: {
    title: 'Opengrep Studio Regelwiki',
    statsRules: 'Regeln gesamt',
    statsPacks: 'Regelpakete',
    statsLangs: 'Oberflächensprache',
    statsCwe: 'CWE-Abdeckung',
    searchPlaceholder: 'Regel-ID, Beschreibung, CWE, OWASP durchsuchen',
    filterPack: 'Regelpaket',
    filterSeverity: 'Schweregrad',
    filterCwe: 'CWE',
    allOption: 'Alle',
    showing: '{shown} / {total} Regeln angezeigt',
    noMatch: 'Keine passenden Regeln. Bitte Filter anpassen',
    loadError: 'Daten konnten nicht geladen werden. Bitte die Seite über einen statischen Server öffnen; data.json und search-index.json müssen im selben Verzeichnis liegen',
    noDescription: 'Keine Beschreibung',
    updated: 'Daten vom {time} · Opengrep Studio',
    backHome: 'Zur Liste',
    cweIndexLink: 'CWE-Index',
    secMessages: 'Meldungen in allen Sprachen',
    secCwe: 'CWE-Wissenskarte',
    secOwasp: 'OWASP',
    secMeta: 'Metadaten',
    secFix: 'Fix-Felder',
    secRelated: 'Zugehörige Regeln',
    thLang: 'Sprache',
    thDesc: 'Meldung',
    thName: 'Name',
    thFix: 'Fix-Hinweis',
    thRules: 'Regeln',
    yesBadge: 'vorhanden',
    noBadge: 'nicht vorhanden',
    upstreamLabel: 'Upstream-Regelquelle',
    noRelated: 'Keine Regeln verweisen auf dieses CWE',
    subRule: 'Regeldetails',
    subCwe: 'CWE-Details',
  },
  fr: {
    title: 'Opengrep Studio Wiki des règles',
    statsRules: 'Règles au total',
    statsPacks: 'Paquets de règles',
    statsLangs: 'Langue de l’interface',
    statsCwe: 'Couverture CWE',
    searchPlaceholder: 'Rechercher par ID de règle, description, CWE, OWASP…',
    filterPack: 'Paquet',
    filterSeverity: 'Gravité',
    filterCwe: 'CWE',
    allOption: 'Toutes',
    showing: '{shown} / {total} règles affichées',
    noMatch: 'Aucune règle correspondante. Ajustez les filtres',
    loadError: 'Échec du chargement des données. Ouvrez la page via un serveur statique avec data.json et search-index.json dans le même répertoire',
    noDescription: 'Aucune description',
    updated: 'Données du {time} · Opengrep Studio',
    backHome: 'Retour à la liste',
    cweIndexLink: 'Index CWE',
    secMessages: 'Messages dans toutes les langues',
    secCwe: 'Fiche CWE',
    secOwasp: 'OWASP',
    secMeta: 'Métadonnées',
    secFix: 'Champs de correction',
    secRelated: 'Règles associées',
    thLang: 'Langue',
    thDesc: 'Message',
    thName: 'Nom',
    thFix: 'Correction proposée',
    thRules: 'Règles',
    yesBadge: 'présent',
    noBadge: 'absent',
    upstreamLabel: 'Source amont',
    noRelated: 'Aucune règle ne référence ce CWE',
    subRule: 'Détail de la règle',
    subCwe: 'Détail du CWE',
  },
  ru: {
    title: 'Opengrep Studio вики правил',
    statsRules: 'Всего правил',
    statsPacks: 'Пакеты правил',
    statsLangs: 'Язык интерфейса',
    statsCwe: 'Покрытие CWE',
    searchPlaceholder: 'Поиск по ID правила, описанию, CWE, OWASP…',
    filterPack: 'Пакет',
    filterSeverity: 'Серьёзность',
    filterCwe: 'CWE',
    allOption: 'Все',
    showing: 'Показано {shown} из {total} правил',
    noMatch: 'Подходящих правил нет. Измените условия фильтра',
    loadError: 'Не удалось загрузить данные. Откройте страницу через статический сервер; data.json и search-index.json должны лежать в том же каталоге',
    noDescription: 'Нет описания',
    updated: 'Данные от {time} · Opengrep Studio',
    backHome: 'К списку',
    cweIndexLink: 'Индекс CWE',
    secMessages: 'Сообщения на всех языках',
    secCwe: 'Карточка CWE',
    secOwasp: 'OWASP',
    secMeta: 'Метаданные',
    secFix: 'Поля исправления',
    secRelated: 'Связанные правила',
    thLang: 'Язык',
    thDesc: 'Сообщение',
    thName: 'Название',
    thFix: 'Исправление',
    thRules: 'Правил',
    yesBadge: 'есть',
    noBadge: 'нет',
    upstreamLabel: 'Исходные правила',
    noRelated: 'Нет правил, ссылающихся на этот CWE',
    subRule: 'Детали правила',
    subCwe: 'Детали CWE',
  },
};

const SITE_LANG_NAMES = { en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어', de: 'Deutsch', fr: 'Français', ru: 'Русский' };

const I18N_SNIPPET = `var I18N = ${JSON.stringify(SITE_I18N)}; var LANG_NAMES = ${JSON.stringify(SITE_LANG_NAMES)};`;

function severityClass(sev) {
  const known = { error: 'error', warning: 'warning', info: 'info' };
  return known[String(sev ?? '').toLowerCase()] ?? 'other';
}

function detailChromeJs(languages) {
  return `(function () {
  ${I18N_SNIPPET}
  var LANGS = ${JSON.stringify(languages)};
  var state = { lang: 'zh' };
  try {
    var saved = localStorage.getItem('rules-site-lang');
    if (saved && I18N[saved]) state.lang = saved;
  } catch (e) {}
  function t(key) {
    var pack = I18N[state.lang];
    return (pack && pack[key]) || I18N.zh[key] || key;
  }
  function apply() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    var prefix = document.documentElement.getAttribute('data-page-title') || '';
    document.title = prefix ? prefix + ' · ' + t('title') : t('title');
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : state.lang;
    var select = document.getElementById('lang');
    if (select) {
      select.value = state.lang;
      select.setAttribute('aria-label', t('statsLangs'));
    }
    var footer = document.getElementById('footer');
    if (footer) footer.textContent = t('updated').split('{time}').join(footer.getAttribute('data-time') || '');
  }
  function init() {
    var select = document.getElementById('lang');
    if (!select) return;
    select.innerHTML = LANGS.filter(function (code) { return Boolean(I18N[code]); }).map(function (code) {
      return '<option value="' + code + '">' + (LANG_NAMES[code] || code) + '</option>';
    }).join('');
    select.value = state.lang;
    select.addEventListener('change', function () {
      state.lang = select.value;
      try { localStorage.setItem('rules-site-lang', state.lang); } catch (e) {}
      apply();
    });
    apply();
  }
  init();
})();`;
}

function detailShell({ pageTitle, h1Html, crumbs, bodyHtml, languages, generatedAt }) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-page-title="${esc(pageTitle)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<style>${SITE_CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>${h1Html}</h1>
    <p class="crumbs">${crumbs}</p>
  </div>
  <select id="lang" aria-label="界面语言"></select>
</header>
${bodyHtml}
<footer id="footer" class="footer" data-time="${esc(generatedAt.slice(0, 10))}"></footer>
</div>
<script>${detailChromeJs(languages)}</script>
</body>
</html>
`;
}

function renderRulePage(rule, data) {
  const langs = ['en', ...data.languages];
  const messageRows = langs
    .map((lang) => {
      const text = lang === 'en' ? rule.message : rule.descriptions[lang];
      return `<tr><th>${esc(lang)}</th><td>${text ? `<p class="msg-text">${esc(text)}</p>` : '<span class="muted">—</span>'}</td></tr>`;
    })
    .join('');
  const cweCards = (rule.cwe ?? [])
    .map((id) => {
      const num = cweNumber(id);
      const rows = data.languages
        .map((lang) => {
          const info = (data.cwe[lang] ?? {})[num] ?? {};
          return `<tr><th>${esc(lang)}</th><td>${info.name ? esc(info.name) : '<span class="muted">—</span>'}</td><td>${info.fix ? esc(info.fix) : '<span class="muted">—</span>'}</td></tr>`;
        })
        .join('');
      return `<div class="cwe-card"><div class="head"><a class="chip cwe" href="../cwe/${encodeURIComponent(num)}.html">${esc(id)}</a></div><table class="lang-table"><thead><tr><th data-i18n="thLang">语言</th><th data-i18n="thName">名称</th><th data-i18n="thFix">修复建议</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
  const metaRows = ['likelihood', 'impact', 'confidence']
    .map((key) => {
      const value = rule[key];
      const chip = value
        ? `<span class="chip pack">${esc(value)}</span>`
        : `<span class="chip badge-no" data-i18n="noBadge">无</span>`;
      return `<div class="kv"><span class="k">${key}</span>${chip}</div>`;
    })
    .join('');
  const fixRows = [
    ['fix', rule.hasFix],
    ['fix-regex', rule.hasFixRegex],
  ]
    .map(
      ([label, present]) =>
        `<div class="kv"><span class="k">${label}</span><span class="chip ${present ? 'badge-yes' : 'badge-no'}" data-i18n="${present ? 'yesBadge' : 'noBadge'}">${present ? '有' : '无'}</span></div>`,
    )
    .join('');
  const sections = [
    `<section class="card"><h2 data-i18n="secMessages">各语言消息对照</h2><table class="lang-table"><thead><tr><th data-i18n="thLang">语言</th><th data-i18n="thDesc">消息</th></tr></thead><tbody>${messageRows}</tbody></table></section>`,
    rule.cwe?.length ? `<section class="card"><h2 data-i18n="secCwe">CWE 知识卡</h2>${cweCards}</section>` : '',
    rule.owasp?.length
      ? `<section class="card"><h2 data-i18n="secOwasp">OWASP</h2><div class="cwes">${rule.owasp.map((item) => `<span class="chip pack">${esc(item)}</span>`).join('')}</div></section>`
      : '',
    `<section class="card"><h2 data-i18n="secMeta">元数据</h2>${metaRows}</section>`,
    `<section class="card"><h2 data-i18n="secFix">修复字段</h2>${fixRows}</section>`,
    rule.upstreamPath
      ? `<section class="card"><h2 data-i18n="upstreamLabel">上游规则源</h2><a class="upstream-link" href="${esc(upstreamBase + encodeURI(rule.upstreamPath))}" target="_blank" rel="noopener">${esc('github.com/opengrep/opengrep-rules/tree/main/' + rule.upstreamPath)}</a></section>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const headChips = [
    `<span class="chip pack">${esc(rule.pack)}</span>`,
    rule.severity ? `<span class="chip sev sev-${severityClass(rule.severity)}">${esc(rule.severity)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  return detailShell({
    pageTitle: rule.id,
    h1Html: esc(rule.id),
    crumbs: `<a href="../index.html" data-i18n="backHome">返回列表</a> · <a href="../cwe/index.html" data-i18n="cweIndexLink">CWE 索引</a>`,
    bodyHtml: `<div class="detail-head">${headChips}<span class="sub" data-i18n="subRule">规则详情</span></div>\n${sections}`,
    languages: data.languages,
    generatedAt: data.generatedAt,
  });
}

function renderCweIndex(data, nums) {
  const baseDict = data.cwe['zh' in data.cwe ? 'zh' : data.languages[0]] ?? {};
  const counts = new Map();
  for (const rule of data.rules) {
    for (const id of rule.cwe ?? []) {
      const num = cweNumber(id);
      counts.set(num, (counts.get(num) ?? 0) + 1);
    }
  }
  const rows = nums
    .map((num) => {
      const name = baseDict[num]?.name ?? '';
      return `<tr><td><a class="rule-link" href="${encodeURIComponent(num)}.html">CWE-${esc(num)}</a></td><td>${name ? esc(name) : '<span class="muted">—</span>'}</td><td>${counts.get(num) ?? 0}</td></tr>`;
    })
    .join('');
  const bodyHtml = `<p class="sub">${nums.length} CWE</p><section class="card"><table class="lang-table"><thead><tr><th>CWE</th><th data-i18n="thName">名称</th><th data-i18n="thRules">规则数</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  return detailShell({
    pageTitle: 'CWE',
    h1Html: `<span data-i18n="cweIndexLink">CWE 索引</span>`,
    crumbs: `<a href="../index.html" data-i18n="backHome">返回列表</a>`,
    bodyHtml,
    languages: data.languages,
    generatedAt: data.generatedAt,
  });
}

function renderCwePage(num, data, related) {
  const rows = data.languages
    .map((lang) => {
      const info = (data.cwe[lang] ?? {})[num] ?? {};
      return `<tr><th>${esc(lang)}</th><td>${info.name ? esc(info.name) : '<span class="muted">—</span>'}</td><td>${info.fix ? esc(info.fix) : '<span class="muted">—</span>'}</td></tr>`;
    })
    .join('');
  const relatedItems = related
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((rule) => {
      const sev = rule.severity ? `<span class="chip sev sev-${severityClass(rule.severity)}">${esc(rule.severity)}</span>` : '';
      return `<li><a href="../rules/${encodeURIComponent(rule.id)}.html">${esc(rule.id)}</a><span class="chip pack">${esc(rule.pack)}</span>${sev}</li>`;
    })
    .join('');
  const relatedBody = related.length
    ? `<ul class="related">${relatedItems}</ul>`
    : `<p class="muted" data-i18n="noRelated">暂无规则引用此 CWE</p>`;
  const zhName = (data.cwe['zh' in data.cwe ? 'zh' : data.languages[0]] ?? {})[num]?.name ?? '';
  const bodyHtml = `<div class="detail-head"><span class="chip cwe">CWE-${esc(num)}</span>${zhName ? `<span class="sub">${esc(zhName)}</span>` : ''}<span class="sub" data-i18n="subCwe">CWE 详情</span></div><section class="card"><table class="lang-table"><thead><tr><th data-i18n="thLang">语言</th><th data-i18n="thName">名称</th><th data-i18n="thFix">修复建议</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2 data-i18n="secRelated">关联规则</h2>${relatedBody}</section>`;
  return detailShell({
    pageTitle: `CWE-${num}`,
    h1Html: `CWE-${esc(num)}`,
    crumbs: `<a href="../index.html" data-i18n="backHome">返回列表</a> · <a href="index.html" data-i18n="cweIndexLink">CWE 索引</a>`,
    bodyHtml,
    languages: data.languages,
    generatedAt: data.generatedAt,
  });
}

function renderHome() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opengrep Studio 规则百科</title>
<style>${SITE_CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1 data-i18n="title">Opengrep Studio 规则百科</h1>
  <div class="head-actions">
    <a class="navlink" href="cwe/index.html" data-i18n="cweIndexLink">CWE 索引</a>
    <select id="lang" aria-label="界面语言"></select>
  </div>
</header>
<section id="stats" class="stats"></section>
<section class="filters">
  <input id="q" type="search" autocomplete="off">
  <label class="field"><span id="label-pack"></span><select id="pack"></select></label>
  <label class="field"><span id="label-severity"></span><select id="severity"></select></label>
  <label class="field"><span id="label-cwe"></span><select id="cwe"></select></label>
</section>
<div id="count" class="count"></div>
<ul id="rules" class="rules"></ul>
<footer id="footer" class="footer"></footer>
<noscript><p class="count error">需要启用 JavaScript 才能浏览规则列表。</p></noscript>
</div>
<script>
(function () {
  ${I18N_SNIPPET}
  var state = { lang: 'zh', q: '', pack: '', severity: '', cwe: '' };
  var data = null;
  var refCwes = [];
  var searchById = new Map();
  var rowById = new Map();
  var listEl = document.getElementById('rules');
  var countEl = document.getElementById('count');
  var statsEl = document.getElementById('stats');
  var footerEl = document.getElementById('footer');
  var langEl = document.getElementById('lang');
  var qEl = document.getElementById('q');
  var packEl = document.getElementById('pack');
  var severityEl = document.getElementById('severity');
  var cweEl = document.getElementById('cwe');

  function t(key) {
    var pack = I18N[state.lang];
    return (pack && pack[key]) || I18N.zh[key] || key;
  }
  function fmt(key, vars) {
    var out = t(key);
    for (var k in vars) out = out.split('{' + k + '}').join(String(vars[k]));
    return out;
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cweKey(id) { return id.replace(/^CWE-/i, ''); }
  function langName(code) { return LANG_NAMES[code] || code; }
  function cweNameOf(id) {
    var entry = (data.cwe[state.lang] || {})[cweKey(id)];
    return entry && typeof entry.name === 'string' ? entry.name : '';
  }
  function descFor(rule) {
    var d = rule.descriptions || {};
    return d[state.lang] || d.zh || rule.message || t('noDescription');
  }
  function severityClassOf(sev) {
    var known = { error: 'error', warning: 'warning', info: 'info' };
    return known[String(sev || '').toLowerCase()] || 'other';
  }
  function collectRefCwes() {
    var set = new Set();
    data.rules.forEach(function (rule) {
      (rule.cwe || []).forEach(function (id) { set.add(id); });
    });
    return Array.from(set).sort(function (a, b) {
      var na = parseInt(cweKey(a), 10);
      var nb = parseInt(cweKey(b), 10);
      return ((isNaN(na) ? 1e9 : na) - (isNaN(nb) ? 1e9 : nb)) || (a < b ? -1 : 1);
    });
  }
  function ruleRowHtml(rule) {
    var badges = '<span class="chip pack">' + escapeHtml(rule.pack) + '</span>';
    if (rule.severity) {
      badges += '<span class="chip sev sev-' + severityClassOf(rule.severity) + '">' + escapeHtml(rule.severity) + '</span>';
    }
    var cwes = (rule.cwe || []).map(function (id) {
      var name = cweNameOf(id);
      return '<a class="chip cwe" href="cwe/' + encodeURIComponent(cweKey(id)) + '.html"' + (name ? ' title="' + escapeHtml(name) + '"' : '') + '>' + escapeHtml(id) + '</a>';
    }).join('');
    return '<li data-id="' + escapeHtml(rule.id) + '"><div class="head"><a class="rule-link" href="rules/' + encodeURIComponent(rule.id) + '.html"><code>' + escapeHtml(rule.id) + '</code></a>' + badges + '</div><p class="msg">' + escapeHtml(descFor(rule)) + '</p>' + (cwes ? '<div class="cwes">' + cwes + '</div>' : '') + '</li>';
  }
  function applyTexts() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.title = t('title');
    qEl.placeholder = t('searchPlaceholder');
    qEl.setAttribute('aria-label', t('searchPlaceholder'));
    langEl.setAttribute('aria-label', t('statsLangs'));
    footerEl.textContent = fmt('updated', { time: String(data.generatedAt || '').slice(0, 10) });
  }
  function renderStats() {
    var dict = data.cwe[state.lang] || {};
    var covered = refCwes.filter(function (id) { return dict[cweKey(id)]; }).length;
    var items = [
      { v: data.ruleCount, k: t('statsRules') },
      { v: data.packs.length, k: t('statsPacks') },
      { v: data.languages.length, k: t('statsLangs') },
      { v: covered + ' / ' + Object.keys(dict).length, k: t('statsCwe') }
    ];
    statsEl.innerHTML = items.map(function (item) {
      return '<div class="stat"><div class="v">' + escapeHtml(item.v) + '</div><div class="k">' + escapeHtml(item.k) + '</div></div>';
    }).join('');
  }
  function fillSelect(sel, options, current) {
    sel.innerHTML = options.map(function (o) {
      return '<option value="' + escapeHtml(o.v) + '"' + (o.v === current ? ' selected' : '') + '>' + escapeHtml(o.k) + '</option>';
    }).join('');
  }
  function renderFilters() {
    fillSelect(packEl, [{ v: '', k: t('allOption') }].concat(data.packs.map(function (p) {
      return { v: p.id, k: p.id + ' (' + p.ruleCount + ')' };
    })), state.pack);
    var sevs = Array.from(new Set(data.rules.map(function (r) { return r.severity || ''; }).filter(Boolean))).sort();
    fillSelect(severityEl, [{ v: '', k: t('allOption') }].concat(sevs.map(function (s) { return { v: s, k: s }; })), state.severity);
    fillSelect(cweEl, [{ v: '', k: t('allOption') }].concat(refCwes.map(function (id) {
      var name = cweNameOf(id);
      return { v: id, k: name ? id + ' ' + name : id };
    })), state.cwe);
  }
  function renderList() {
    listEl.innerHTML = data.rules.map(ruleRowHtml).join('');
    rowById.clear();
    Array.prototype.forEach.call(listEl.children, function (li) {
      rowById.set(li.getAttribute('data-id'), li);
    });
  }
  function apply() {
    var q = state.q.trim().toLowerCase();
    var shown = 0;
    var filtered = Boolean(q || state.pack || state.severity || state.cwe);
    rowById.forEach(function (li, id) {
      var rule = data.rulesById.get(id);
      var ok = true;
      if (ok && state.pack && rule.pack !== state.pack) ok = false;
      if (ok && state.severity && (rule.severity || '') !== state.severity) ok = false;
      if (ok && state.cwe && (rule.cwe || []).indexOf(state.cwe) < 0) ok = false;
      if (ok && q) {
        var blob = searchById.get(id);
        if (typeof blob !== 'string' || blob.indexOf(q) < 0) ok = false;
      }
      li.hidden = !ok;
      if (ok) shown += 1;
    });
    countEl.className = shown === 0 && filtered ? 'count error' : 'count';
    countEl.textContent = shown === 0 && filtered ? t('noMatch') : fmt('showing', { shown: shown, total: data.ruleCount });
  }
  function setLang(lang) {
    state.lang = data.languages.indexOf(lang) >= 0 ? lang : 'zh';
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : state.lang;
    try { localStorage.setItem('rules-site-lang', state.lang); } catch (e) {}
    applyTexts();
    renderStats();
    renderFilters();
    renderList();
    apply();
  }
  function init() {
    var saved = null;
    try { saved = localStorage.getItem('rules-site-lang'); } catch (e) {}
    Promise.all([
      fetch('data.json').then(function (r) { return r.json(); }),
      fetch('search-index.json').then(function (r) { return r.json(); })
    ]).then(function (res) {
      data = res[0];
      data.rulesById = new Map();
      data.rules.forEach(function (rule) { data.rulesById.set(rule.id, rule); });
      (res[1].entries || []).forEach(function (entry) { searchById.set(entry.id, entry.search); });
      refCwes = collectRefCwes();
      langEl.innerHTML = data.languages.map(function (code) {
        return '<option value="' + escapeHtml(code) + '">' + escapeHtml(langName(code)) + '</option>';
      }).join('');
      var initial = saved && data.languages.indexOf(saved) >= 0 ? saved : 'zh';
      langEl.value = initial;
      langEl.addEventListener('change', function () { setLang(langEl.value); });
      var timer = 0;
      qEl.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { state.q = qEl.value; apply(); }, 120);
      });
      packEl.addEventListener('change', function () { state.pack = packEl.value; apply(); });
      severityEl.addEventListener('change', function () { state.severity = severityEl.value; apply(); });
      cweEl.addEventListener('change', function () { state.cwe = cweEl.value; apply(); });
      setLang(initial);
    }).catch(function () {
      countEl.className = 'count error';
      countEl.textContent = t('loadError');
    });
  }
  init();
})();
</script>
</body>
</html>
`;
}

function buildSite(data) {
  const pages = new Map();
  pages.set('index.html', renderHome());
  const cweRuleMap = new Map();
  for (const rule of data.rules) {
    pages.set(`rules/${rule.id}.html`, renderRulePage(rule, data));
    for (const id of rule.cwe ?? []) {
      const num = cweNumber(id);
      if (!cweRuleMap.has(num)) cweRuleMap.set(num, []);
      cweRuleMap.get(num).push(rule);
    }
  }
  const baseCwe = data.cwe['zh' in data.cwe ? 'zh' : data.languages[0]] ?? {};
  const nums = Object.keys(baseCwe).sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  for (const num of nums) {
    pages.set(`cwe/${num}.html`, renderCwePage(num, data, cweRuleMap.get(num) ?? []));
  }
  pages.set('cwe/index.html', renderCweIndex(data, nums));
  return pages;
}

function resolveSitePath(fromRelPath, link) {
  const dir = path.posix.dirname(fromRelPath);
  const stack = dir === '.' ? [] : dir.split('/');
  for (const part of link.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function stripScripts(html) {
  return html.replace(/<script>[\s\S]*?<\/script>/g, '');
}

function inspectSite(data, pages) {
  const linkProblems = [];
  const placeholderPages = [];
  const missingLangPages = [];
  let linkCount = 0;
  for (const [relPath, html] of pages) {
    const staticHtml = stripScripts(html);
    for (const match of staticHtml.matchAll(/(href|src)="([^"]*)"/g)) {
      const link = match[2];
      if (!link || link.startsWith('#') || /^(https?:)?\/\//i.test(link) || /^(mailto|data):/i.test(link)) continue;
      linkCount += 1;
      const target = resolveSitePath(relPath, link);
      if (!pages.has(target)) linkProblems.push(`${relPath} 内部链接落空：${link}（解析为 ${target}）`);
    }
    const hasPlaceholder =
      /="{{/.test(staticHtml) ||
      />{{/.test(staticHtml) ||
      /="undefined"/.test(staticHtml) ||
      />undefined</.test(staticHtml) ||
      /="TODO"/.test(staticHtml) ||
      />TODO</.test(staticHtml);
    if (hasPlaceholder) placeholderPages.push(relPath);
    if (relPath.startsWith('rules/')) {
      const table = staticHtml.match(/<table class="lang-table">[\s\S]*?<\/table>/);
      const missing = data.languages.filter((lang) => !table || !table[0].includes(`<th>${lang}</th>`));
      if (missing.length) missingLangPages.push(`${relPath} 缺少语言列：${missing.join('、')}`);
    }
  }
  const problems = [];
  for (const line of linkProblems.slice(0, 5)) problems.push(line);
  if (linkProblems.length > 5) problems.push(`内部链接落空的页面共 ${linkProblems.length} 个`);
  for (const relPath of placeholderPages.slice(0, 5)) problems.push(`存在未替换的占位符痕迹：${relPath}`);
  if (placeholderPages.length > 5) problems.push(`存在占位符痕迹的页面共 ${placeholderPages.length} 个`);
  for (const line of missingLangPages.slice(0, 5)) problems.push(line);
  if (missingLangPages.length > 5) problems.push(`缺少语言列的详情页共 ${missingLangPages.length} 个`);
  return { problems, linkCount, pageCount: pages.size };
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
      ? '[build-rules-site] 校验未通过；请修复上方条目后重跑 node server/scripts/build-rules-site.mjs --check（规则说明/CWE 缺键可参考 npm run i18n:check 的口径同步全部 messages-*.json / cwe-*.json）'
      : '[build-rules-site] 已取消生成 site/dist；请先修复上方条目再重跑',
  );
  process.exit(1);
}

console.log('[build-rules-site] 校验全部通过 ✔');

const { data, searchIndex } = buildDataset(collected, messages, cwe);
const pages = buildSite(data);
const site = inspectSite(data, pages);
console.log(`[build-rules-site] 整站自检：${site.pageCount} 个页面 / ${site.linkCount} 个内部链接 / ${data.rules.length} 个规则详情页语言列`);

if (site.problems.length) {
  console.error(`[build-rules-site] 整站自检发现 ${site.problems.length} 个问题：`);
  for (const line of site.problems) console.error(`- ${line}`);
  console.error(
    check
      ? '[build-rules-site] 整站自检未通过；请修复上方条目后重跑 node server/scripts/build-rules-site.mjs --check'
      : '[build-rules-site] 已取消生成 site/dist；请先修复上方条目再重跑',
  );
  process.exit(1);
}

if (check) {
  console.log('[build-rules-site] 整站自检通过 ✔（内部链接全部可达 · 无占位符痕迹 · 详情页语言列齐全）');
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'data.json'), JSON.stringify(data));
fs.writeFileSync(path.join(distDir, 'search-index.json'), JSON.stringify(searchIndex));
for (const [relPath, html] of pages) {
  const outFile = path.join(distDir, relPath);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
}
const rulePageCount = [...pages.keys()].filter((key) => key.startsWith('rules/')).length;
const cwePageCount = [...pages.keys()].filter((key) => key.startsWith('cwe/') && key !== 'cwe/index.html').length;
console.log(`[build-rules-site] 已生成 site/dist/data.json（${formatSize(fs.statSync(path.join(distDir, 'data.json')).size)}）`);
console.log(`[build-rules-site] 已生成 site/dist/search-index.json（${formatSize(fs.statSync(path.join(distDir, 'search-index.json')).size)}）`);
console.log(`[build-rules-site] 已生成 site/dist/index.html（${formatSize(fs.statSync(path.join(distDir, 'index.html')).size)}）`);
console.log(`[build-rules-site] 已生成 site/dist/rules/（${rulePageCount} 个规则详情页）`);
console.log(`[build-rules-site] 已生成 site/dist/cwe/（${cwePageCount} 个 CWE 详情页 + 1 个索引）`);
