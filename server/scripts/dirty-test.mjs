/**
 * API 脏测试：正常 / 异常 / 边界全覆盖。
 * - expect4xx / expect2xx 断言；拒绝类请求不落库，成功类"脏但合法"的数据保留供人工复核。
 * 用法：node server/scripts/dirty-test.mjs
 */
// 与 e2e.mjs 一致：默认钉死 IPv4 回环，可用 BASE_URL 覆盖
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const results = [];
let passed = 0, failed = 0;

async function call(pathname, init) {
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const json = (data) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const postJson = (data) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** 幂等创建：同名项目已存在则复用（重跑不堆积重复脏数据） */
async function ensureProject(name, description) {
  const existing = (await call('/api/projects')).body.find((p) => p.name === name);
  if (existing) return existing;
  const res = await call('/api/projects', postJson({ name, description }));
  if (res.status >= 300) throw new Error(`创建项目 ${name} 失败: ${JSON.stringify(res.body)}`);
  return res.body;
}

function record(label, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  <<< ' + detail}`);
  ok ? passed++ : failed++;
}
const expect4xx = (label, res, contains) => {
  const statusOk = res.status >= 400 && res.status < 500;
  const containsOk = contains === undefined || JSON.stringify(res.body).includes(contains);
  record(
    label,
    statusOk && containsOk,
    `status=${res.status}${containsOk ? '' : ` 未含期望报文「${contains}」`} body=${JSON.stringify(res.body).slice(0, 120)}`,
  );
};
const expect2xx = (label, res) =>
  record(label, res.status >= 200 && res.status < 300, `status=${res.status} body=${JSON.stringify(res.body).slice(0, 120)}`);

async function fdPost(pathname, fd) {
  const res = await fetch(BASE + pathname, { method: 'POST', body: fd });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  console.log('===== 一、项目 Projects =====');
  // 正常 + 持久脏数据：unicode/表情名、50 字符边界名
  const weirdNames = ['测试项目🎯emoji+中文', 'B'.repeat(50)];
  const weirdProjects = [];
  for (const name of weirdNames) {
    const p = await ensureProject(name, '脏测试保留数据');
    record(`创建/复用项目[边界名 ${name.length} 字符]`, Boolean(p.id));
    weirdProjects.push(p.id);
  }
  let res = await call('/api/projects', postJson({ name: '' }));
  expect4xx('空项目名 → 400', res);
  res = await call('/api/projects', postJson({ name: 'C'.repeat(51) }));
  expect4xx('51 字符项目名 → 400', res);
  res = await call('/api/projects', postJson({ name: '   ' }));
  expect4xx('纯空格项目名 → 400', res);
  res = await call('/api/projects/p-nonexistent', { method: 'PATCH', ...json({ name: 'x' }) });
  expect4xx('PATCH 不存在的项目 → 404', res);

  console.log('===== 二、源码上传 =====');
  // 持久脏项目：多文件上传（含中文/空格文件名）
  const uploadProject = await ensureProject('脏测试-多文件上传', '脏测试保留：中文与空格文件名的散装上传');
  const fd = new FormData();
  const fileA = new Blob(['console.log("hello 脏测试");\n'], { type: 'text/javascript' });
  fd.append('files', fileA, 'a.js');
  fd.append('files', new Blob(['x=1\n'], { type: 'text/plain' }), '带 空格 的文件.py');
  fd.append('paths', 'src/a.js');
  fd.append('paths', '深度/目录/带 空格 的文件.py');
  let up = await fdPost(`/api/projects/${uploadProject.id}/source`, fd);
  expect2xx('多文件上传（中文/空格路径）', up);

  // 路径穿越（三种形态）
  for (const evil of ['../evil.txt', 'a/../../evil.txt', '/abs/evil.txt']) {
    const fd2 = new FormData();
    fd2.append('files', new Blob(['x'], { type: 'text/plain' }), 'f.txt');
    fd2.append('paths', evil);
    const r2 = await fdPost(`/api/projects/${uploadProject.id}/source`, fd2);
    expect4xx(`路径穿越 paths=${evil} → 400`, r2, '不安全');
  }
  // Windows 非法文件名字符（曾为 500，修复后应为 400）
  for (const evil of ['evil<1>.txt', 'a:b.txt', 'q?*.js']) {
    const fd2b = new FormData();
    fd2b.append('files', new Blob(['x'], { type: 'text/plain' }), 'f.txt');
    fd2b.append('paths', evil);
    const r2b = await fdPost(`/api/projects/${uploadProject.id}/source`, fd2b);
    expect4xx(`非法文件名字符 paths=${evil} → 400`, r2b);
  }
  // 空 files
  const fd3 = new FormData();
  up = await fdPost(`/api/projects/${uploadProject.id}/source`, fd3);
  expect4xx('空上传（无 file/files 字段）→ 4xx', up);
  // 伪 zip：文本内容命名 .zip
  const fd4 = new FormData();
  fd4.append('file', new Blob(['this is not a zip'], { type: 'application/zip' }), 'fake.zip');
  up = await fdPost(`/api/projects/${uploadProject.id}/source`, fd4);
  expect4xx('伪造 zip（非压缩内容）→ 400', up);
  // 压缩包与散文件混传
  const fd5 = new FormData();
  fd5.append('file', new Blob([Buffer.from('PK\x03\x04' + 'x'.repeat(50))], { type: 'application/zip' }), 'mix.zip');
  fd5.append('files', new Blob(['y'], { type: 'text/plain' }), 'loose.txt');
  up = await fdPost(`/api/projects/${uploadProject.id}/source`, fd5);
  expect4xx('压缩包与散文件混传 → 400', up);

  console.log('===== 三、Git 克隆 =====');
  for (const url of ['ssh://git@github.com/x/y.git', 'ftp://example.com/repo', 'not a url at all']) {
    res = await call(`/api/projects/${uploadProject.id}/clone`, postJson({ url }));
    expect4xx(`非法克隆地址 ${url} → 400`, res);
  }
  res = await call(`/api/projects/${uploadProject.id}/clone`, postJson({ url: 'https://github.com/expressjs/express', ref: '../evil' }));
  expect4xx('非法 ref（含 ..）→ 400', res);
  res = await call(`/api/projects/${uploadProject.id}/clone`, postJson({ url: 'https://github.com/expressjs/express', ref: '.hidden' }));
  expect4xx('ref 以点开头 → 400', res);
  res = await call('/api/projects/p-none/clone', postJson({ url: 'https://github.com/x/y' }));
  expect4xx('克隆到不存在项目 → 404', res);

  console.log('===== 四、扫描配置 =====');
  const packs = (await call('/api/rulepacks')).body;
  const packIds = packs.slice(0, 2).map((p) => p.id);
  const badConfigs = [
    ['空名称', { rulePackIds: packIds, timeoutSeconds: 30, jobs: 4, maxTargetBytes: 1000000 }],
    ['51 字符名称', { name: 'C'.repeat(51), rulePackIds: packIds, timeoutSeconds: 30, jobs: 4, maxTargetBytes: 1000000 }],
    ['零规则包', { name: 'X配置', rulePackIds: [], timeoutSeconds: 30, jobs: 4, maxTargetBytes: 1000000 }],
    ['不存在的规则包', { name: 'X配置', rulePackIds: ['pack-not-exist'], timeoutSeconds: 30, jobs: 4, maxTargetBytes: 1000000 }],
    ['timeout=0', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 0, jobs: 4, maxTargetBytes: 1000000 }],
    ['timeout=601', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 601, jobs: 4, maxTargetBytes: 1000000 }],
    ['timeout=30.5', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 30.5, jobs: 4, maxTargetBytes: 1000000 }],
    ['jobs=0', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 30, jobs: 0, maxTargetBytes: 1000000 }],
    ['jobs=17', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 30, jobs: 17, maxTargetBytes: 1000000 }],
    ['maxTargetBytes=50000', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 30, jobs: 4, maxTargetBytes: 50000 }],
    ['maxTargetBytes=100000001（100MB 上限 +1 越界）', { name: 'X配置', rulePackIds: packIds, timeoutSeconds: 30, jobs: 4, maxTargetBytes: 100000001 }],
  ];
  for (const [label, payload] of badConfigs) {
    res = await call('/api/configs', postJson(payload));
    expect4xx(`配置[${label}] → 400`, res);
  }
  let configs = (await call('/api/configs')).body;
  if (!Array.isArray(configs) || configs.length === 0) {
    // 空库自播种：保证后续"重名 400"等用例有存量配置可用（幂等，重跑走 expect2xx）
    res = await call('/api/configs', postJson({ name: '脏测试-基线配置', rulePackIds: packIds, timeoutSeconds: 30, jobs: 4, maxTargetBytes: 1000000 }));
    expect2xx('配置[空库自播种] 创建成功', res);
    configs = (await call('/api/configs')).body;
  }
  res = await call('/api/configs', postJson({ name: configs[0].name, rulePackIds: packIds, timeoutSeconds: 30, jobs: 4, maxTargetBytes: 1000000 }));
  expect4xx('配置重名 → 400', res);
  // 正常：边界值全顶格（持久脏数据；重跑幂等——已存在则跳过）
  const existingCfg = (await call('/api/configs')).body.some((c) => c.name === '脏测试-边界顶格配置');
  if (existingCfg) {
    record('配置[全部边界顶格值] 已存在（幂等跳过）', true);
  } else {
    res = await call('/api/configs', postJson({ name: '脏测试-边界顶格配置', description: 'timeout=600/jobs=16/maxBytes=100MB 顶格保留', rulePackIds: packIds, timeoutSeconds: 600, jobs: 16, maxTargetBytes: 100000000 }));
    expect2xx('配置[全部边界顶格值] 创建成功', res);
  }

  console.log('===== 五、规则包 =====');
  const badPacks = [
    ['空名称', { language: 'Java', content: 'rules:\n  - id: x\n    message: m\n    severity: ERROR\n    languages: [java]\n    pattern: $X' }],
    ['51 字符名称', { name: 'P'.repeat(51), language: 'Java', content: 'rules: []' }],
    ['空内容', { name: '脏测试X', language: 'Java', content: '   ' }],
    ['非法 YAML', { name: '脏测试X', language: 'Java', content: '::: not [valid yaml' }],
    ['rules 为空数组', { name: '脏测试X', language: 'Java', content: 'rules: []' }],
    ['规则缺 id', { name: '脏测试X', language: 'Java', content: 'rules:\n  - message: m\n    severity: ERROR\n    languages: [java]\n    pattern: $X' }],
    ['规则缺 pattern', { name: '脏测试X', language: 'Java', content: 'rules:\n  - id: r1\n    message: m\n    severity: ERROR\n    languages: [java]\n' }],
    ['规则 id 重复', { name: '脏测试X', language: 'Java', content: 'rules:\n  - id: r1\n    message: m\n    severity: ERROR\n    languages: [java]\n    pattern: $X\n  - id: r1\n    message: m2\n    severity: ERROR\n    languages: [java]\n    pattern: $Y' }],
  ];
  for (const [label, payload] of badPacks) {
    res = await call('/api/rulepacks', postJson(payload));
    expect4xx(`规则包[${label}] → 400`, res);
  }
  const builtin = packs.find((p) => p.builtin);
  res = await call(`/api/rulepacks/${builtin.id}/content`, { method: 'PUT', ...json({ content: 'rules: []' }) });
  expect4xx('在线编辑内置包 → 403', res);
  res = await call(`/api/rulepacks/${builtin.id}`, { method: 'DELETE' });
  expect4xx('删除内置包 → 403', res);
  res = await fetch(`${BASE}/api/rulepacks/${builtin.id}/export`);
  record('导出内置包 → 403', res.status === 403, `status=${res.status}`);
  res = await call(`/api/rulepacks/${builtin.id}`, { method: 'PATCH', ...json({ enabled: 'yes' }) });
  expect4xx('PATCH enabled 非布尔 → 400', res);
  res = await call('/api/rulepacks/pack-none', { method: 'PATCH', ...json({ enabled: true }) });
  expect4xx('PATCH 不存在的规则包 → 404', res);
  // 正常：表情名规则包（持久脏数据；幂等）
  const dirtyPackExists = packs.some((p) => p.name === '脏测试-调试规则🐞');
  if (dirtyPackExists) {
    record('规则包[表情名+中文规则] 已存在（幂等跳过）', true);
  } else {
    res = await call('/api/rulepacks', postJson({
      name: '脏测试-调试规则🐞', language: 'JavaScript',
      content: 'rules:\n  - id: dirty-debug-rule\n    message: 脏测试调试规则（debugger 语句）\n    severity: WARNING\n    languages: [javascript]\n    pattern: debugger\n',
    }));
    expect2xx('规则包[表情名+中文规则] 创建成功', res);
  }

  console.log('===== 六、规则实验室 =====');
  res = await call('/api/rulelab/run', postJson({ yaml: '::: bad yaml', samples: {} }));
  expect2xx('实验室[非法 YAML] → error 判定', res);
  record('  判定为 error', res.body.verdict === 'error', `verdict=${res.body.verdict}`);
  res = await call('/api/rulelab/run', postJson({
    yaml: 'rules:\n  - id: never-match\n    message: m\n    severity: ERROR\n    languages: [javascript]\n    pattern: COMPLETELY_UNKNOWN_FUNC($A)\n',
    samples: { positive: 'somethingTotallyDifferent(1);' },
  }));
  expect2xx('实验室[正例不命中] → fail 判定', res);
  record('  判定为 fail', res.body.verdict === 'fail', `verdict=${res.body.verdict}`);
  res = await call('/api/rulelab/run', postJson({
    yaml: 'rules:\n  - id: dirty-lab-pass\n    message: 脏测试通过规则\n    severity: ERROR\n    languages: [javascript]\n    pattern: eval(...)\n',
    samples: { positive: 'eval("1+1");', negative: 'const x = 1;' },
  }));
  expect2xx('实验室[正反例正确] → pass 判定', res);
  record('  判定为 pass', res.body.verdict === 'pass', `verdict=${res.body.verdict}`);

  console.log('===== 七、扫描 =====');
  const bare = await ensureProject('脏测试-未绑定配置项目', '脏测试保留：用于验证未绑定配置的扫描拒绝');
  res = await call(`/api/projects/${bare.id}/scans`, postJson({}));
  expect4xx('未绑定配置的扫描 → 400', res);
  res = await call('/api/projects/p-none/scans', postJson({}));
  expect4xx('扫描不存在项目 → 404', res);
  res = await call(`/api/projects/${bare.id}/scans`, postJson({ rules: 'no-such-ruleset' }));
  expect4xx('未知字段不能绕过配置校验 → 400', res);

  console.log('===== 八、人工复核 =====');
  const reviewProject = await ensureProject('脏测试-复核边界', '脏测试保留：复核边界数据');
  res = await call(`/api/projects/${reviewProject.id}/reviews`, json({ fingerprint: 'f1', status: 'bogus' }));
  expect4xx('复核[非法 status] → 400', res);
  res = await call(`/api/projects/${reviewProject.id}/reviews`, json({ fingerprint: 'x'.repeat(513), status: 'confirmed' }));
  expect4xx('复核[fingerprint 513 字符] → 400', res);
  res = await call(`/api/projects/${reviewProject.id}/reviews`, json({ fingerprint: 'f1', status: 'confirmed', reason: 'r'.repeat(501) }));
  expect4xx('复核[reason 501 字符] → 400', res);
  res = await call(`/api/projects/${reviewProject.id}/reviews`, json({ fingerprint: 'f1', status: 'confirmed', reviewer: 'v'.repeat(101) }));
  expect4xx('复核[reviewer 101 字符] → 400', res);
  // 正常：500 字符 reason 顶格 + 不存在的 fingerprint 也会落库（脏数据保留）
  res = await call(`/api/projects/${reviewProject.id}/reviews`, json({ fingerprint: 'dirty-fp-' + 'z'.repeat(480), status: 'confirmed', reason: '边界'.repeat(250), reviewer: '脏测试复核员' }));
  expect2xx('复核[reason 顶格 500 字符 + 怪指纹] → 落库', res);
  res = await call(`/api/projects/p-none/reviews`, json({ fingerprint: 'f1', status: 'confirmed' }));
  expect4xx('复核到不存在项目 → 404', res);

  console.log('===== 九、SARIF 导入导出 =====');
  const sarifProject = await ensureProject('脏测试-外部SARIF导入', '脏测试保留：模拟 CodeQL 外部结果导入');
  const sarifAlready = (await call(`/api/projects/${sarifProject.id}/scans`)).body.some((s) => (s.rules ?? '').includes('CodeQL'));
  const fdSarif = (content, filename) => {
    const f = new FormData();
    f.append('file', new Blob([JSON.stringify(content)], { type: 'application/json' }), filename);
    return f;
  };
  up = await fdPost(`/api/projects/${sarifProject.id}/sarif`, fdSarif({ hello: 'world' }, 'bad.json'));
  expect4xx('SARIF[非 SARIF 结构] → 400', up);
  up = await fdPost(`/api/projects/${sarifProject.id}/sarif`, fdSarif({ version: '2.1.0' }, 'no-runs.sarif'));
  expect4xx('SARIF[缺 runs] → 400', up);
  up = await fdPost(`/api/projects/${sarifProject.id}/sarif`, fdSarif({ version: '1.0.0', runs: [] }, 'v1.sarif'));
  expect4xx('SARIF[1.0 版本] → 400', up);
  // 正常：模拟 CodeQL 结果（持久脏数据）
  const codeqlSarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'CodeQL', informationUri: 'https://codeql.github.com', version: '2.17.0' } },
      results: [
        { ruleId: 'js/sql-injection', level: 'error', message: { text: 'SQL 拼接注入（脏测试外部结果）' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db/query.js' }, region: { startLine: 42 } } }], partialFingerprints: { 'dirty/v1': 'codeql-fp-1' } },
        { ruleId: 'js/hardcoded-credentials', level: 'error', message: { text: 'Hardcoded credential' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/config.js' }, region: { startLine: 7 } } }], partialFingerprints: { 'dirty/v1': 'codeql-fp-2' } },
        { ruleId: 'js/clear-text-logging', level: 'warning', message: { text: 'Clear-text logging of sensitive information' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/log.js' }, region: { startLine: 15 } } }], partialFingerprints: { 'dirty/v1': 'codeql-fp-3' } },
      ],
    }],
  };
  if (sarifAlready) {
    record('SARIF[CodeQL 模拟结果] 已导入（幂等跳过）', true);
  } else {
    up = await fdPost(`/api/projects/${sarifProject.id}/sarif`, fdSarif(codeqlSarif, 'codeql-dirty.sarif'));
    expect2xx('SARIF[CodeQL 模拟结果] 导入成功', up);
  }

  console.log('===== 十、只读接口（导出/报告/清单/对比/知识库/片段） =====');
  const scans = (await call('/api/scans')).body;
  const completed = scans.filter((s) => s.status === 'completed');
  // 优先选"同项目 ≥2 次扫描"的记录（diff 语义最全）；否则退而取任意已完成扫描（SARIF 导入的也行）
  const seedScan =
    completed.find((s) => scans.filter((x) => x.projectId === s.projectId).length >= 2)
    ?? completed[0];
  if (!seedScan) throw new Error('库中没有任何已完成扫描：请先跑一次 npm run e2e 或导入 SARIF 再执行脏测试');
  let r = await fetch(`${BASE}/api/scans/${seedScan.id}/sarif`);
  record('SARIF 导出 → 200', r.status === 200, `status=${r.status}`);
  const sarifDoc = await r.json();
  record('  导出为 SARIF 2.1.0', sarifDoc.version === '2.1.0', `version=${sarifDoc.version}`);
  r = await fetch(`${BASE}/api/scans/${seedScan.id}/manifest`);
  record('manifest 导出 → 200', r.status === 200, `status=${r.status}`);
  r = await fetch(`${BASE}/api/scans/${seedScan.id}/report?format=html`);
  record('离线 HTML 报告 → 200', r.status === 200, `status=${r.status}`);
  r = await fetch(`${BASE}/api/scans/scan-not-exist/sarif`);
  record('导出不存在扫描 → 404', r.status === 404, `status=${r.status}`);
  r = await fetch(`${BASE}/api/scans/scan-not-exist/manifest`);
  record('manifest 不存在扫描 → 404', r.status === 404, `status=${r.status}`);
  res = await call(`/api/scans/${seedScan.id}/diff?against=${seedScan.id}`);
  expect4xx('diff 对比自己（同扫描）→ 400 拒绝', res);
  res = await call(`/api/scans/${seedScan.id}/diff`);
  expect4xx('diff 缺 against 参数 → 400', res);
  res = await call(`/api/scans/${seedScan.id}/diff?against=scan-not-exist`);
  expect4xx('diff 对比不存在的扫描 → 404', res);
  res = await call(`/api/rules/knowledge/corp-js-weak-hash`);
  expect2xx('知识库[自定义规则] → 200', res);
  res = await call('/api/rules/knowledge/no-such-rule-xyz');
  record('知识库[未知规则] → 200 空壳或 404（不崩溃）', res.status === 200 || res.status === 404, `status=${res.status}`);
  res = await call(`/api/scans/${seedScan.id}/snippet?path=../../../server/src/index.ts&start=1&end=5`);
  record('代码片段[路径穿越] → 不返回服务器文件', res.status >= 400 || !String(res.body?.content ?? '').includes('HttpError'), `status=${res.status}`);
  res = await call(`/api/scans/${seedScan.id}/snippet?path=config.js&start=-5&end=99999`);
  record('代码片段[越界行号] → 不崩溃', res.status >= 200 && res.status < 500, `status=${res.status}`);

  console.log('===== 十一、其他 =====');
  r = await fetch(`${BASE}/api/no-such-endpoint`);
  record('未知端点 → 404（有 JSON 错误体）', r.status === 404, `status=${r.status}`);
  res = await call('/api/health');
  expect2xx('健康检查 → 200', res);

  console.log('\n========================================');
  console.log(`结果：PASS ${passed} / FAIL ${failed}（共 ${passed + failed}）`);
  if (results.some((line) => line.startsWith('FAIL'))) {
    console.log('\n失败用例：');
    results.filter((l) => l.startsWith('FAIL')).forEach((l) => console.log('  ' + l));
    process.exit(1);
  }
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(1); });
