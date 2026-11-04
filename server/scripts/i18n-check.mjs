import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const i18nDir = path.join(root, 'code', 'src', 'i18n');

function leaves(value, prefix = '', out = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') leaves(child, next, out);
    else out.add(next);
  }
  return out;
}

function leafEntries(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') leafEntries(child, next, out);
    else out.set(next, String(child));
  }
  return out;
}

const langs = ['zh', 'en', 'zh-Hant', 'ja', 'ko'];
const ui = {};
const uiValues = {};
for (const lang of langs) {
  const mod = await import(pathToFileURL(path.join(i18nDir, `${lang}.ts`)).href);
  ui[lang] = leaves(mod.default);
  uiValues[lang] = leafEntries(mod.default);
}

const problems = [];
const base = ui.zh;
for (const lang of langs) {
  const missing = [...base].filter((key) => !ui[lang].has(key));
  const extra = [...ui[lang]].filter((key) => !base.has(key));
  if (missing.length) problems.push(`${lang} 缺少 ${missing.length} 个键：${missing.slice(0, 5).join('、')}`);
  if (extra.length) problems.push(`${lang} 多出 ${extra.length} 个键：${extra.slice(0, 5).join('、')}`);
}

const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, 'server', 'rules', file), 'utf8'));

const ruleLangs = ['zh-Hant', 'ja', 'ko'];
const checkPair = (prefix, display) => {
  const zh = readJson(`${prefix}-zh.json`);
  const counts = [`zh=${Object.keys(zh).length}`];
  for (const lang of ruleLangs) {
    const other = readJson(`${prefix}-${lang}.json`);
    const missing = Object.keys(zh).filter((key) => !(key in other));
    const extra = Object.keys(other).filter((key) => !(key in zh));
    if (missing.length) {
      problems.push(`${prefix}-${lang} 缺少 ${missing.length} 条：${missing.slice(0, 5).join('、')}`);
    }
    if (extra.length) {
      problems.push(`${prefix}-${lang} 多出 ${extra.length} 条：${extra.slice(0, 5).join('、')}`);
    }
    for (const key of Object.keys(zh)) {
      if (!(key in other)) continue;
      const expectedVars = varsOfValue(zh[key]);
      const actualVars = varsOfValue(other[key]);
      if (expectedVars !== actualVars) {
        problems.push(`${prefix}-${lang} 键 ${key} 的插值变量不一致：zh="${expectedVars}" ${lang}="${actualVars}"`);
      }
    }
    counts.push(`${lang}=${Object.keys(other).length}`);
  }
  console.log(`${display}：${counts.join(' / ')}`);
};

const serverSrc = path.join(root, 'server', 'src');
const serverFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith('.ts') && path.basename(full) !== 'report.ts') serverFiles.push(full);
  }
};
walk(serverSrc);

const serverCodes = new Set();
for (const file of serverFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/code:\s*'([a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/errorCode:\s*'([a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/reasonCode:\s*'([a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/abortCode = '([a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/new ScanError\(\s*'([a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/\bfail\(\s*'([a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/'(ruleYaml\.[a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/'(engine\.[a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/'(lab\.[a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);
  for (const match of text.matchAll(/\$\{codePrefix\}(TooManyFiles|TooLarge|Empty)/g)) {
    serverCodes.add(`archive.extract${match[1]}`);
    serverCodes.add(`archive.tarExtract${match[1]}`);
  }
}
const engineInstallText = fs.readFileSync(
  path.join(root, 'server', 'scripts', 'engine-install.mjs'),
  'utf8',
);
for (const match of engineInstallText.matchAll(/'(engine\.[a-zA-Z0-9_.]+)'/g)) serverCodes.add(match[1]);

for (const code of serverCodes) {
  for (const lang of langs) {
    if (!ui[lang].has(`apiErrors.${code}`)) {
      problems.push(`${lang} 缺少错误码文案 apiErrors.${code}`);
    }
  }
}

const varsOf = (text) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');

const varsOfValue = (value) =>
  typeof value === 'string'
    ? varsOf(value)
    : Object.values(value ?? {})
        .map((item) => varsOf(String(item ?? '')))
        .sort()
        .join(';');
for (const [key, zhValue] of uiValues.zh) {
  const expected = varsOf(zhValue);
  for (const lang of langs) {
    if (lang === 'zh') continue;
    const value = uiValues[lang].get(key);
    if (value === undefined) continue;
    const actual = varsOf(value);
    if (actual !== expected) {
      problems.push(`${key} 的 ${lang} 插值变量不一致：zh="${expected}" ${lang}="${actual}"`);
    }
  }
}

const CJK = /[\u4e00-\u9fff]/;
const hanChecks = [
  ['en', new Set(['lang.zh', 'lang.zhHant', 'lang.ja', 'lang.ko'])],
  ['ko', new Set(['lang.zh', 'lang.zhHant', 'lang.ja'])],
];
for (const [lang, cjkAllowed] of hanChecks) {
  for (const [key, value] of uiValues[lang]) {
    if (CJK.test(value) && !cjkAllowed.has(key)) {
      problems.push(`${lang}.${key} 仍含汉字：${value.slice(0, 40)}`);
    }
  }
}

console.log(`UI 叶子键：${langs.map((lang) => `${lang}=${ui[lang].size}`).join(' / ')}`);
console.log(`服务端错误码：${serverCodes.size}（五包 apiErrors 覆盖校验）`);
checkPair('messages', '规则说明');
checkPair('cwe', 'CWE 知识库');

if (problems.length) {
  console.error('\n发现不一致：');
  for (const line of problems) console.error(`- ${line}`);
  console.error('请同步 code/src/i18n 五份语言包与 server/rules/messages-*.json、cwe-*.json（各语言同键），再重跑 npm run i18n:check');
  process.exitCode = 1;
} else {
  console.log('i18n 资源一致');
}
