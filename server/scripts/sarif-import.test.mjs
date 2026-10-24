// SARIF 导入解析单测（node --test 运行，`npm test` 统一驱动）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSarifImport } from '../src/sarif-import.ts';

const RULE_ID = 'ts/hardcoded-secret';

function sarif(results, extra = {}) {
  return JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: '外部扫描器', rules: [{ id: RULE_ID, shortDescription: { text: '硬编码密钥' } }] } },
        results,
      },
    ],
    ...extra,
  });
}

test('基础映射：ruleId/level→severity/路径/行号/合成指纹', () => {
  const { toolName, issues } = parseSarifImport(
    sarif([
      {
        ruleId: RULE_ID,
        level: 'error',
        message: { text: '发现硬编码密钥' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 12, endLine: 12 } } }],
      },
    ]),
  );
  assert.equal(toolName, '外部扫描器');
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    id: '',
    scanId: '',
    fingerprint: `${RULE_ID}:src/a.ts:12`,
    ruleId: RULE_ID,
    severity: 'high',
    comparisonStatus: 'remaining',
    message: '发现硬编码密钥',
    filePath: 'src/a.ts',
    startLine: 12,
    endLine: 12,
    matchedLines: undefined,
    rulepackId: undefined,
    rulepackName: undefined,
  });
});

test('Studio 导出的 properties.severity 与 partialFingerprints 往返无损', () => {
  const { issues } = parseSarifImport(
    sarif([
      {
        ruleId: RULE_ID,
        level: 'warning',
        message: { text: 'x' },
        properties: { severity: 'critical' },
        partialFingerprints: { 'opengrepFingerprint/v1': 'engine-fp-001' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } }],
      },
    ]),
  );
  assert.equal(issues[0].severity, 'critical', 'properties.severity 优先于 level');
  assert.equal(issues[0].fingerprint, 'engine-fp-001');
});

test('level 映射：warning→medium / note→low / 缺省→low', () => {
  const { issues } = parseSarifImport(
    sarif([
      { ruleId: 'r1', level: 'warning', message: { text: 'x' } },
      { ruleId: 'r2', level: 'note', message: { text: 'x' } },
      { ruleId: 'r3', message: { text: 'x' } },
    ]),
  );
  assert.deepEqual(issues.map((i) => i.severity), ['medium', 'low', 'low']);
});

test('缺 ruleId 时回退 rules[ruleIndex].id；message 回退规则描述', () => {
  const { issues } = parseSarifImport(
    sarif([
      {
        ruleIndex: 0,
        message: {},
        locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 3 } } }],
      },
    ]),
  );
  assert.equal(issues[0].ruleId, RULE_ID);
  assert.equal(issues[0].message, '硬编码密钥');
});

test('file:// 与 %20 路径归一；反斜杠转正斜杠；盘符伪根剥离', () => {
  const { issues } = parseSarifImport(
    sarif([
      { ruleId: 'r1', message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///D:/code/my%20app/src%2Fb.ts' } } }] },
      { ruleId: 'r2', message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src\\c.ts' } } }] },
    ]),
  );
  assert.equal(issues[0].filePath, 'D:/code/my app/src/b.ts');
  assert.equal(issues[1].filePath, 'src/c.ts');
});

test('多 run 合并 + 按 fingerprint 去重；多 run 工具名取首个', () => {
  const doc = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: '工具A' } },
        results: [
          { ruleId: 'r1', message: { text: 'x' }, partialFingerprints: { fp: 'same-1' } },
          { ruleId: 'r2', message: { text: 'x' }, partialFingerprints: { fp: 'same-1' } },
        ],
      },
      {
        tool: { driver: { name: '工具B' } },
        results: [{ ruleId: 'r3', message: { text: 'x' }, partialFingerprints: { fp: 'same-1' } }],
      },
    ],
  };
  const { toolName, issues } = parseSarifImport(JSON.stringify(doc));
  assert.equal(toolName, '工具A');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].ruleId, 'r1');
});

test('空 results 合法（干净基线工作流）', () => {
  const { toolName, issues } = parseSarifImport(sarif([]));
  assert.equal(toolName, '外部扫描器');
  assert.equal(issues.length, 0);
});

test('region 缺省时行号为 1；无 locations 时路径占位', () => {
  const { issues } = parseSarifImport(sarif([{ ruleId: 'r1', message: { text: 'x' } }]));
  assert.equal(issues[0].startLine, 1);
  assert.equal(issues[0].endLine, 1);
  assert.equal(issues[0].filePath, '（未知路径）');
});

test('非法输入全部 400：坏 JSON / 非 2.x / 缺 runs / 顶层非对象', () => {
  assert.throws(() => parseSarifImport('{ broken'), /JSON/);
  assert.throws(() => parseSarifImport(JSON.stringify({ version: '1.0.0', runs: [] })), /SARIF 2\.x/);
  assert.throws(() => parseSarifImport(JSON.stringify({ version: '2.1.0' })), /runs/);
  assert.throws(() => parseSarifImport(JSON.stringify([1, 2])), /顶层/);
});
