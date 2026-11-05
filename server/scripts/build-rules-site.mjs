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

function renderHome() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opengrep Studio 规则百科</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: #f8fafc; color: #0f172a; font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; font-size: 14px; line-height: 1.55; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 56px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 20px; }
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
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 0; cursor: default; font-family: inherit; }
.chip.pack { background: #f1f5f9; color: #475569; }
.chip.sev.sev-error { background: #fee2e2; color: #b91c1c; }
.chip.sev.sev-warning { background: #fef3c7; color: #92400e; }
.chip.sev.sev-info { background: #dbeafe; color: #1d4ed8; }
.chip.sev.sev-other { background: #e5e7eb; color: #374151; }
.chip.cwe { background: #eff6ff; color: #1e40af; cursor: pointer; }
.chip.cwe:hover { background: #dbeafe; }
.msg { margin: 6px 0 0; color: #334155; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cwes { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.footer { margin-top: 18px; color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Opengrep Studio 规则百科</h1>
  <select id="lang" aria-label="界面语言"></select>
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
  var I18N = {
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
      updated: '数据生成于 {time} · Opengrep Studio'
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
      updated: '資料產生於 {time} · Opengrep Studio'
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
      updated: 'データ生成日 {time} · Opengrep Studio'
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
      updated: '데이터 생성일 {time} · Opengrep Studio'
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
      updated: 'Daten vom {time} · Opengrep Studio'
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
      updated: 'Données du {time} · Opengrep Studio'
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
      updated: 'Данные от {time} · Opengrep Studio'
    }
  };
  var LANG_NAMES = { zh: '简体中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어', de: 'Deutsch', fr: 'Français', ru: 'Русский' };
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
  function severityClass(sev) {
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
      badges += '<span class="chip sev sev-' + severityClass(rule.severity) + '">' + escapeHtml(rule.severity) + '</span>';
    }
    var cwes = (rule.cwe || []).map(function (id) {
      var name = cweNameOf(id);
      return '<button type="button" class="chip cwe" data-cwe="' + escapeHtml(id) + '"' + (name ? ' title="' + escapeHtml(name) + '"' : '') + '>' + escapeHtml(id) + '</button>';
    }).join('');
    return '<li data-id="' + escapeHtml(rule.id) + '"><div class="head"><code>' + escapeHtml(rule.id) + '</code>' + badges + '</div><p class="msg">' + escapeHtml(descFor(rule)) + '</p>' + (cwes ? '<div class="cwes">' + cwes + '</div>' : '') + '</li>';
  }
  function applyTexts() {
    document.title = t('title');
    document.getElementById('label-pack').textContent = t('filterPack');
    document.getElementById('label-severity').textContent = t('filterSeverity');
    document.getElementById('label-cwe').textContent = t('filterCwe');
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
      listEl.addEventListener('click', function (event) {
        var chip = event.target.closest('.chip.cwe');
        if (!chip) return;
        state.cwe = chip.getAttribute('data-cwe');
        cweEl.value = state.cwe;
        apply();
      });
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
fs.writeFileSync(path.join(distDir, 'index.html'), renderHome());
console.log(`[build-rules-site] 已生成 site/dist/data.json（${formatSize(fs.statSync(path.join(distDir, 'data.json')).size)}）`);
console.log(`[build-rules-site] 已生成 site/dist/search-index.json（${formatSize(fs.statSync(path.join(distDir, 'search-index.json')).size)}）`);
console.log(`[build-rules-site] 已生成 site/dist/index.html（${formatSize(fs.statSync(path.join(distDir, 'index.html')).size)}）`);
