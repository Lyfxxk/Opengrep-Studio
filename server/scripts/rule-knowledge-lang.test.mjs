import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-knowledge-lang-'));
process.env.DATA_DIR = tempDataDir;
process.env.CUSTOM_RULES_DIR = path.join(tempDataDir, 'rules-custom');

const { insertRulePack, closeDatabase } = await import('../src/db.ts');
const { getRuleKnowledge } = await import('../src/knowledge.ts');
const { parseProductLang } = await import('../src/routes/shared.ts');
const { trackTempDir } = await import('./temp-dir.mjs');
trackTempDir(tempDataDir, closeDatabase);

const rulesDir = path.join(import.meta.dirname, '..', 'rules');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(rulesDir, name), 'utf8'));
const messagesZh = readJson('messages-zh.json');
const messagesHant = readJson('messages-zh-Hant.json');

insertRulePack({
  id: 'builtin-bash',
  name: 'Bash',
  language: 'Bash',
  builtin: true,
  enabled: true,
  ruleCount: 5,
  createdAt: '2026-11-01T00:00:00.000Z',
});

const RULE = 'bash.curl-eval';
const CJK = /[一-鿿]/;

test('zh 说明与修复建议取随包词典，逐字不变', () => {
  const knowledge = getRuleKnowledge(RULE, 'zh');
  assert.equal(knowledge.found, true);
  assert.equal(knowledge.message, messagesZh[RULE]);
  assert.equal(CJK.test(knowledge.message ?? ''), true);
  assert.equal((knowledge.fixSuggestion ?? '').length > 0, true);
  const cwe = knowledge.cwe.find((item) => item.id === 'CWE-95');
  assert.ok(cwe, 'CWE-95 应在列');
  assert.equal(CJK.test(cwe.name ?? ''), true);
  assert.equal((cwe.fix ?? '').length > 0, true);
});

test('zh-Hant 走繁体词典', () => {
  const knowledge = getRuleKnowledge(RULE, 'zh-Hant');
  assert.equal(knowledge.message, messagesHant[RULE]);
  assert.equal((knowledge.fixSuggestion ?? '').length > 0, true);
});

test('en 说明取规则自带原文，不含汉字也不含中文修复建议', () => {
  const knowledge = getRuleKnowledge(RULE, 'en');
  assert.equal(knowledge.found, true);
  assert.equal((knowledge.message ?? '').length > 0, true);
  assert.equal(CJK.test(knowledge.message ?? ''), false);
  assert.equal(/curl/i.test(knowledge.message ?? ''), true);
  assert.equal(knowledge.fixSuggestion, undefined);
  assert.equal(knowledge.cwe.length > 0, true);
  for (const item of knowledge.cwe) {
    assert.equal(item.fix, undefined);
    assert.equal(CJK.test(item.name ?? ''), false);
  }
  assert.equal(
    knowledge.cwe.some((item) => (item.name ?? '').length > 0),
    true,
    'en 的 CWE 名应来自规则 metadata',
  );
});

test('未知规则在 en 下也返回 found:false 且不带说明', () => {
  const knowledge = getRuleKnowledge('no-such-rule-xyz', 'en');
  assert.equal(knowledge.found, false);
  assert.equal('message' in knowledge, false);
});

test('接口语言参数只认三种标识，其余回落简体', () => {
  assert.equal(parseProductLang('en'), 'en');
  assert.equal(parseProductLang('zh-Hant'), 'zh-Hant');
  assert.equal(parseProductLang('zh'), 'zh');
  assert.equal(parseProductLang('fr'), 'zh');
  assert.equal(parseProductLang(undefined), 'zh');
  assert.equal(parseProductLang(['zh', 'en']), 'zh');
});
