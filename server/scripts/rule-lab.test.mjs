import fs from 'node:fs';
import path from 'node:path';
import { trackTempDir, useTempDataDir } from './script-utils.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tempDataDir = useTempDataDir('og-rule-lab-');

const { parseRuleYaml, cleanupRuleLabScratch } = await import('../src/rule-lab.ts');
const { closeDatabase } = await import('../src/db.ts');
trackTempDir(tempDataDir, closeDatabase);

const VALID = `rules:
  - id: js-dangerous-eval
    languages: [javascript]
    message: 使用 eval 动态执行代码
    severity: WARNING
    pattern: eval(...)
`;

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });

function throwCode(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return undefined;
}

test('合法规则：返回规则数与 id 列表', () => {
  const parsed = parseRuleYaml(VALID);
  assert.equal(parsed.ruleCount, 1);
  assert.deepEqual(parsed.ruleIds, ['js-dangerous-eval']);
  assert.equal(parsed.firstLanguage, 'javascript');
});

test('YAML 语法错误：抛出并带原因', () => {
  throwsCode(() => parseRuleYaml('rules: [ { broken'), 'ruleYaml.parseFailed');
});

test('顶层缺少非空 rules 列表：拒绝', () => {
  throwsCode(() => parseRuleYaml('foo: bar'), 'ruleYaml.rulesMissing');
  throwsCode(() => parseRuleYaml('rules: []'), 'ruleYaml.rulesMissing');
});

test('缺少 id / languages / pattern 表达式：逐条报原因', () => {
  throwsCode(
    () => parseRuleYaml('rules:\n  - languages: [javascript]\n    pattern: eval(...)\n'),
    'ruleYaml.missingId',
  );
  throwsCode(
    () => parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n'),
    'ruleYaml.missingLanguages',
  );
  throwsCode(
    () => parseRuleYaml('rules:\n  - id: a\n    languages: [javascript]\n    message: x\n'),
    'ruleYaml.missingPattern',
  );
});

test('校验失败带可翻译错误码与参数', () => {
  assert.equal(
    throwCode(() => parseRuleYaml('rules:\n  - languages: [javascript]\n    pattern: eval(...)\n')),
    'ruleYaml.missingId',
  );
  assert.equal(
    throwCode(() => parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n')),
    'ruleYaml.missingLanguages',
  );
  assert.equal(
    throwCode(() => parseRuleYaml('rules:\n  - id: a\n    languages: [javascript]\n    message: x\n')),
    'ruleYaml.missingPattern',
  );
  assert.equal(throwCode(() => parseRuleYaml('rules: [ { broken')), 'ruleYaml.parseFailed');
  assert.equal(throwCode(() => parseRuleYaml('foo: bar')), 'ruleYaml.rulesMissing');
  try {
    parseRuleYaml('rules:\n  - id: a\n    message: x\n    pattern: eval(...)\n');
    assert.fail('应当抛出');
  } catch (error) {
    assert.equal(error.code, 'ruleYaml.missingLanguages');
    assert.equal(error.params?.index, 1);
    assert.equal(error.params?.id, 'a');
  }
});

test('非对象规则条目：按缺少 id 报业务错误而不是 TypeError', () => {
  throwsCode(() => parseRuleYaml('rules:\n  - null\n'), 'ruleYaml.missingId');
  throwsCode(() => parseRuleYaml('rules:\n  - 42\n'), 'ruleYaml.missingId');
});

test('taint 模式无需 pattern 前缀键', () => {
  const parsed = parseRuleYaml(`rules:
  - id: taint-eval
    languages: [javascript]
    message: x
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: req.query
    pattern-sinks:
      - pattern: eval(...)
`);
  assert.equal(parsed.ruleCount, 1);
  assert.deepEqual(parsed.ruleIds, ['taint-eval']);
});

test('重复规则 id：拒绝', () => {
  throwsCode(
    () =>
      parseRuleYaml(`rules:
  - id: dup-rule
    languages: [javascript]
    message: x
    pattern: eval(...)
  - id: dup-rule
    languages: [javascript]
    message: y
    pattern: eval(...)
`),
    'ruleYaml.duplicateId',
  );
});

test('firstLanguage 取第一条规则 languages[0]', () => {
  const parsed = parseRuleYaml(`rules:
  - id: a
    languages: [python]
    message: x
    pattern: eval(...)
  - id: b
    languages: [javascript]
    message: x
    pattern: eval(...)
`);
  assert.equal(parsed.firstLanguage, 'python');
});

const scratchRoot = path.join(tempDataDir, 'rulelab');

function makeLabDir(name, ageMs = 0) {
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rule.yaml'), 'rules: []\n', 'utf8');
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, past, past);
  }
  return dir;
}

test('刚建好的实验室目录（引擎即将读取）保留不动', () => {
  const fresh = makeLabDir('lab-fresh');
  cleanupRuleLabScratch();
  assert.ok(fs.existsSync(path.join(fresh, 'rule.yaml')), '进行中实验的 rule.yaml 不应被启动清理删掉');
});

test('超过保留期的 lab-* 残留被清掉，且可重复执行（幂等）', () => {
  makeLabDir('lab-stale', 11 * 60 * 1000);
  cleanupRuleLabScratch();
  cleanupRuleLabScratch();
  assert.ok(!fs.existsSync(path.join(scratchRoot, 'lab-stale')), '崩溃残留应在启动时清理');
});

test('非 lab- 前缀的条目不当实验室临时目录看，一律不碰', () => {
  const keep = path.join(scratchRoot, 'keep.txt');
  fs.writeFileSync(keep, 'x', 'utf8');
  cleanupRuleLabScratch();
  assert.ok(fs.existsSync(keep), '启动清理只认 lab-* 前缀');
});

test('rulelab 根目录不存在时清理是无害的空操作', () => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  assert.doesNotThrow(() => cleanupRuleLabScratch());
});
