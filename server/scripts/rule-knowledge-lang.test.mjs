import fs from 'node:fs';
import path from 'node:path';
import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-knowledge-lang-');

const { insertRulePack, closeDatabase } = await import('../src/db.ts');
const { getRuleKnowledge, listRuleMessages } = await import('../src/knowledge.ts');
const { parseProductLang } = await import('../src/routes/shared.ts');
trackTempDir(tempDataDir, closeDatabase);

const rulesDir = path.join(import.meta.dirname, '..', 'rules');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(rulesDir, name), 'utf8'));
const messagesZh = readJson('messages-zh.json');
const messagesHant = readJson('messages-zh-Hant.json');
const messagesJa = readJson('messages-ja.json');
const messagesKo = readJson('messages-ko.json');
const cweJa = readJson('cwe-ja.json');
const cweKo = readJson('cwe-ko.json');

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
const HANGUL = /[가-힣]/;

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

test('ja 走日语词典，CWE 名称与修复建议逐字取自随包日语词典', () => {
  const knowledge = getRuleKnowledge(RULE, 'ja');
  assert.equal(knowledge.found, true);
  assert.equal(knowledge.message, messagesJa[RULE]);
  assert.equal(CJK.test(knowledge.message ?? ''), true);
  const cwe = knowledge.cwe.find((item) => item.id === 'CWE-95');
  assert.ok(cwe, 'CWE-95 应在列');
  assert.equal(cwe.name, cweJa['95'].name);
  assert.equal(cwe.fix, cweJa['95'].fix);
  assert.equal(knowledge.fixSuggestion, cweJa['95'].fix);
});

test('ko 走韩语词典，说明含谚文不含汉字', () => {
  const knowledge = getRuleKnowledge(RULE, 'ko');
  assert.equal(knowledge.found, true);
  assert.equal(knowledge.message, messagesKo[RULE]);
  assert.equal(HANGUL.test(knowledge.message ?? ''), true);
  assert.equal(CJK.test(knowledge.message ?? ''), false);
  const cwe = knowledge.cwe.find((item) => item.id === 'CWE-95');
  assert.ok(cwe, 'CWE-95 应在列');
  assert.equal(cwe.name, cweKo['95'].name);
  assert.equal(cwe.fix, cweKo['95'].fix);
  assert.equal(knowledge.fixSuggestion, cweKo['95'].fix);
});

test('en 说明取规则自带原文不含汉字，CWE 名称与修复建议回落简体词典', () => {
  const knowledge = getRuleKnowledge(RULE, 'en');
  assert.equal(knowledge.found, true);
  assert.equal((knowledge.message ?? '').length > 0, true);
  assert.equal(CJK.test(knowledge.message ?? ''), false);
  assert.equal(/curl/i.test(knowledge.message ?? ''), true);
  const cwe = knowledge.cwe.find((item) => item.id === 'CWE-95');
  assert.ok(cwe, 'CWE-95 应在列');
  assert.equal((cwe.name ?? '').length > 0, true, 'en 的 CWE 名回落随包简体词典');
  assert.equal((cwe.fix ?? '').length > 0, true);
  assert.equal((knowledge.fixSuggestion ?? '').length > 0, true, 'en 的修复建议回落简体词典');
});

test('未知规则在 en 下也返回 found:false 且不带说明', () => {
  const knowledge = getRuleKnowledge('no-such-rule-xyz', 'en');
  assert.equal(knowledge.found, false);
  assert.equal('message' in knowledge, false);
});

test('接口语言参数只认五种标识，其余回落简体', () => {
  assert.equal(parseProductLang('en'), 'en');
  assert.equal(parseProductLang('zh-Hant'), 'zh-Hant');
  assert.equal(parseProductLang('zh'), 'zh');
  assert.equal(parseProductLang('ja'), 'ja');
  assert.equal(parseProductLang('ko'), 'ko');
  assert.equal(parseProductLang('fr'), 'zh');
  assert.equal(parseProductLang(undefined), 'zh');
  assert.equal(parseProductLang(['zh', 'en']), 'zh');
});

test('listRuleMessages 按语言返回磁盘随包词典', () => {
  assert.deepEqual(listRuleMessages('zh'), messagesZh);
  assert.deepEqual(listRuleMessages('zh-Hant'), messagesHant);
  assert.deepEqual(listRuleMessages('ja'), messagesJa);
  assert.deepEqual(listRuleMessages('ko'), messagesKo);
});
