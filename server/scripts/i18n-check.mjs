/**
 * i18n 资源一致性校验：
 *   1. UI 三份语言包（zh / en / zh-Hant）的叶子键必须完全一致；
 *   2. 规则说明 messages-zh.json 与 messages-zh-Hant.json 必须同键。
 *
 * 任一不一致即退出码 1，CI 与本地都跑同一份口径。
 * 用法：npm --prefix server run i18n:check
 */
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

const langs = ['zh', 'en', 'zh-Hant'];
const ui = {};
for (const lang of langs) {
  const mod = await import(pathToFileURL(path.join(i18nDir, `${lang}.ts`)).href);
  ui[lang] = leaves(mod.default);
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
const zhMessages = readJson('messages-zh.json');
const hantMessages = readJson('messages-zh-Hant.json');
const missingMessages = Object.keys(zhMessages).filter((key) => !(key in hantMessages));
const extraMessages = Object.keys(hantMessages).filter((key) => !(key in zhMessages));
if (missingMessages.length) {
  problems.push(`messages-zh-Hant 缺少 ${missingMessages.length} 条：${missingMessages.slice(0, 5).join('、')}`);
}
if (extraMessages.length) {
  problems.push(`messages-zh-Hant 多出 ${extraMessages.length} 条：${extraMessages.slice(0, 5).join('、')}`);
}

console.log(`UI 叶子键：${langs.map((lang) => `${lang}=${ui[lang].size}`).join(' / ')}`);
console.log(`规则说明：zh=${Object.keys(zhMessages).length} / zh-Hant=${Object.keys(hantMessages).length}`);

if (problems.length) {
  console.error('\n发现不一致：');
  for (const line of problems) console.error(`- ${line}`);
  process.exitCode = 1;
} else {
  console.log('i18n 资源一致');
}
