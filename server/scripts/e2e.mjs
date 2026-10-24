import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

// 默认钉死 IPv4 回环：服务端只绑 127.0.0.1，localhost 在部分机器上解析为 ::1 会被拦（EACCES）
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
let failures = 0;

function assert(cond, label, extra = '') {
  if (cond) { console.log(`  PASS ${label}`); }
  else { failures += 1; console.log(`  FAIL ${label} ${extra}`); }
}

async function api(method, path, body) {
  const res = await fetchRetry(BASE + path, {
    method,
    headers: body instanceof FormData
      ? undefined
      : typeof body === 'string'
        ? { 'Content-Type': 'application/json' }
        : body !== undefined
          ? { 'Content-Type': 'application/json' }
          : undefined,
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

/** Windows 下 undici 与服务端 keep-alive 存在偶发 ECONNRESET 竞态，失败重试 2 次 */
async function fetchRetry(url, init, tries = 3) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastError;
}

async function pollScan(scanId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await api('GET', `/api/scans/${scanId}`);
    if (json.status !== 'scanning') return json;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`轮询超时: ${scanId}`);
}


const SAMPLE_TS_V1 = `const apiKey = "sk-1234567890abcdef";
const dbPassword = "P@ssw0rd!";

export function hashToken(token: string) {
  return md5(token);
}

export function getUser(id: string) {
  return db.query(\`SELECT * FROM users WHERE id=\${id}\`);
}

export function runDynamic(code: string) {
  return eval(code);
}
`;

const SAMPLE_TS_V2 = SAMPLE_TS_V1.replace(/export function runDynamic[\s\S]*?\n}\n/, '')
  + '\nconst slackWebhookToken = "xoxb-000-111-222";\n';

const SAMPLE_FILES = {
  'api.ts': SAMPLE_TS_V1,
  'Vault.java': `public class Vault {
    private String dbPassword = "P@ssw0rd!";
    public String hash(String input) throws Exception {
        return MessageDigest.getInstance("MD5").digest(input.getBytes()).toString();
    }
    public void run(String cmd) throws Exception {
        Runtime.getRuntime().exec(cmd);
    }
}
`,
  'main.go': `package main

var apiToken = "sk-9876543210"

func Run(cmd string) {
\texec.Command("sh", "-c", cmd)
}
`,
  'util.py': `API_TOKEN = "sk-abcdef123456"

def hash_password(pwd):
    return hashlib.md5(pwd.encode()).hexdigest()
`,
};

function makeZip(override) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(SAMPLE_FILES)) {
    zip.addFile(`demo-src/${name}`, Buffer.from(override?.[name] ?? content, 'utf8'));
  }
  return zip.toBuffer();
}

const PACK_JS_YAML = `rules:
  - id: js-hardcoded-secret
    languages: [javascript, typescript]
    message: 检测到硬编码的密钥/API Key/密码
    severity: ERROR
    metadata:
      security-severity: "9.1"
      cwe:
      - 'CWE-798: Use of Hard-coded Credentials'
    patterns:
      - pattern: $KEY = "..."
      - metavariable-regex:
          metavariable: $KEY
          regex: (?i).*((secret)|(apikey)|(api_key)|(token)|(passwd)|(password)|(pwd)).*
  - id: js-weak-hash-md5
    languages: [javascript, typescript]
    message: 使用弱哈希算法 MD5
    severity: ERROR
    metadata:
      security-severity: "7.5"
    pattern-either:
      - pattern: md5(...)
      - pattern: crypto.createHash("md5")
  - id: js-sql-injection-concat
    languages: [javascript, typescript]
    message: SQL 语句使用字符串拼接
    severity: ERROR
    metadata:
      security-severity: "9.0"
    pattern-either:
      - pattern: $DB.query(\`...\${$X}...\`)
      - pattern: $DB.execute(\`...\${$X}...\`)
  - id: js-dangerous-eval
    languages: [javascript, typescript]
    message: 使用 eval 动态执行代码
    severity: WARNING
    pattern: eval(...)
  - id: js-insecure-random
    languages: [javascript, typescript]
    message: Math.random 不是密码学安全的随机数
    severity: INFO
    pattern: Math.random()
`;

const PACK_JAVA_YAML = `rules:
  - id: java-hardcoded-secret
    languages: [java]
    message: 硬编码密码/密钥
    severity: ERROR
    metadata:
      security-severity: "9.1"
    patterns:
      - pattern: String $F = $V;
      - metavariable-regex:
          metavariable: $F
          regex: (?i).*((secret)|(apikey)|(api_key)|(token)|(passwd)|(password)|(pwd)).*
      - metavariable-regex:
          metavariable: $V
          regex: ^".+"$
  - id: java-weak-hash
    languages: [java]
    message: 使用弱哈希算法（MD5/SHA-1）
    severity: ERROR
    metadata:
      security-severity: "7.5"
    pattern-either:
      - pattern: MessageDigest.getInstance("MD5")
      - pattern: MessageDigest.getInstance("SHA-1")
      - pattern: MessageDigest.getInstance("SHA1")
  - id: java-command-injection
    languages: [java]
    message: Runtime.exec 执行外部命令
    severity: WARNING
    pattern: Runtime.getRuntime().exec(...)
  - id: java-insecure-random
    languages: [java]
    message: java.util.Random 不是密码学安全的随机数
    severity: INFO
    pattern: new Random(...)
`;

async function uploadPack(name, language, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/yaml' }), `${name}.yaml`);
  form.append('name', name);
  form.append('language', language);
  const res = await api('POST', '/api/rulepacks/upload', form);
  if (res.status !== 201) throw new Error(`上传规则包失败: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function createConfig(values) {
  const res = await api('POST', '/api/configs', values);
  if (res.status !== 201) throw new Error(`创建配置失败: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function makeProjectWithSource(name) {
  const created = await api('POST', '/api/projects', { name, language: 'TypeScript' });
  const form = new FormData();
  form.append('file', new Blob([makeZip()], { type: 'application/zip' }), 'sample.zip');
  await api('POST', `/api/projects/${created.json.id}/source`, form);
  return created.json.id;
}


console.log('== 1. 健康检查 ==');
const health = await api('GET', '/api/health');
assert(health.json?.ok === true, 'health ok', JSON.stringify(health.json));
assert(
  typeof health.json?.engine === 'string' && health.json.engine !== 'MISSING' && health.json.engineHint === undefined,
  '引擎路径存在',
  JSON.stringify(health.json),
);
assert(
  health.json.platform === process.platform && health.json.arch === process.arch,
  'health 含运行平台信息', JSON.stringify(health.json),
);
assert(
  ['env', 'bundled-dir', 'path'].includes(health.json?.engineSource),
  '引擎解析来源已标注', health.json?.engineSource,
);
assert(typeof health.json?.engineVersion === 'string' && health.json.engineVersion.length > 0,
  'health 含期望引擎版本', health.json?.engineVersion);

console.log('== 2. 清理上一轮 E2E 残留（只动 E2E 前缀资源，绝不碰用户已有数据） ==');
const isE2eName = (name) => typeof name === 'string' && name.startsWith('E2E');
for (const p of (await api('GET', '/api/projects')).json ?? []) {
  if (!isE2eName(p.name)) continue;
  await api('DELETE', `/api/projects/${p.id}`);
  console.log(`  已删除上轮 E2E 项目 ${p.id}（${p.name}）`);
}
for (const c of (await api('GET', '/api/configs')).json ?? []) {
  if (!isE2eName(c.name)) continue;
  await api('DELETE', `/api/configs/${c.id}`);
}
for (const rp of (await api('GET', '/api/rulepacks')).json ?? []) {
  if (rp.builtin || !isE2eName(rp.name)) continue;
  await api('DELETE', `/api/rulepacks/${rp.id}`);
}
// 只断言 E2E 自身残留已清空；库中用户数据原样保留
const e2eLeftover = [
  ...((await api('GET', '/api/projects')).json ?? []).filter((p) => isE2eName(p.name)),
  ...((await api('GET', '/api/configs')).json ?? []).filter((c) => isE2eName(c.name)),
  ...((await api('GET', '/api/rulepacks')).json ?? []).filter((rp) => !rp.builtin && isE2eName(rp.name)),
];
assert(e2eLeftover.length === 0, '上一轮 E2E 残留已清理', JSON.stringify(e2eLeftover.map((x) => x.name)));

console.log('== 3. 自建规则包与配置 ==');
const packJs = await uploadPack('E2E-JS规则包', 'JavaScript', PACK_JS_YAML);
const packJava = await uploadPack('E2E-Java规则包', 'Java', PACK_JAVA_YAML);
assert(packJs.ruleCount === 5, `JS 包解析到 5 条规则 (got ${packJs.ruleCount})`);
assert(packJava.ruleCount === 4, `Java 包解析到 4 条规则 (got ${packJava.ruleCount})`);
const onlinePack = await api('POST', '/api/rulepacks', {
  name: 'E2E-在线创建包',
  language: 'Python',
  content: 'rules:\n  - id: py-hardcoded-secret\n    languages: [python]\n    message: 硬编码密钥\n    severity: ERROR\n    pattern: $K = $V\n    metavariable-regex:\n      metavariable: $K\n      regex: (?i).*(secret|token).*\n',
});
assert(onlinePack.status === 201 && onlinePack.json.ruleCount === 1, '在线创建规则包成功且解析规则数');
const badOnline = await api('POST', '/api/rulepacks', {
  name: 'E2E-坏YAML包',
  language: 'Python',
  content: 'rules: [ { broken',
});
assert(badOnline.status === 400, '在线创建的非法 YAML 被拒绝', JSON.stringify(badOnline.json));

const fullConfig = await createConfig({
  name: 'E2E-全量配置',
  description: '勾选 JS + Java 两个包',
  rulePackIds: [packJs.id, packJava.id],
  excludes: [],
  includes: [],
  timeoutSeconds: 30,
  jobs: 4,
  maxTargetBytes: 5000000,
});
assert(fullConfig.id.startsWith('cfg-'), '创建扫描配置成功');

console.log('== 4. 创建项目 ==');
const created = await api('POST', '/api/projects', {
  name: 'E2E演示项目',
  description: '联调冒烟测试',
  language: 'TypeScript',
});
assert(created.status === 201 && created.json.id?.startsWith('p-'), '创建成功');
assert(created.json.name === 'E2E演示项目', '中文名称无乱码', created.json.name);
const pid = created.json.id;

console.log('== 5. 上传源码并绑定配置扫描（v1，无基线） ==');
const form = new FormData();
form.append('file', new Blob([makeZip()], { type: 'application/zip' }), 'sample-v1.zip');
const up = await api('POST', `/api/projects/${pid}/source`, form);
assert(up.status === 200 && up.json.fileCount === 4, `上传解压 4 个文件 (got ${up.json?.fileCount})`);

const noConfigScan = await api('POST', `/api/projects/${pid}/scans`, {});
assert(noConfigScan.status === 400, '未绑定配置时拒绝扫描', JSON.stringify(noConfigScan.json));
await api('PATCH', `/api/projects/${pid}`, { configId: fullConfig.id });

const scan1 = await api('POST', `/api/projects/${pid}/scans`, {});
assert(scan1.status === 201 && scan1.json.status === 'scanning', '扫描已提交');
assert(scan1.json.rules === fullConfig.id, '扫描使用绑定的配置', JSON.stringify(scan1.json));
const s1 = await pollScan(scan1.json.id);
assert(s1.status === 'completed', 'v1 扫描完成', JSON.stringify(s1));
assert(s1.issueCount > 0, `v1 发现 ${s1.issueCount} 个问题`);

const { json: issues1 } = await api('GET', `/api/scans/${s1.id}/issues`);
assert(issues1.length === s1.issueCount, 'issues 数量与记录一致');
const sample = issues1[0];
assert(sample.ruleId && !sample.ruleId.includes('.'), 'ruleId 已剥离路径前缀', sample.ruleId);
assert(['critical', 'high', 'medium', 'low'].includes(sample.severity), 'severity 已映射', sample.severity);
assert(sample.comparisonStatus === 'remaining', '无基线时默认 remaining', sample.comparisonStatus);
assert(!sample.filePath.includes(':') && !sample.filePath.startsWith('/'), 'filePath 是相对路径', sample.filePath);
const criticals = issues1.filter((i) => i.severity === 'critical');
assert(criticals.length >= 3, `security-severity>=9 映射为 critical (got ${criticals.length})`);
const goOrPy = issues1.filter((i) => i.filePath.endsWith('.go') || i.filePath.endsWith('.py'));
assert(goOrPy.length === 0, '未勾选的 Go/Python 规则不产生命中', `${goOrPy.length}`);
console.log(`  v1 样例: ${sample.ruleId} @ ${sample.filePath}:${sample.startLine} [${sample.severity}]`);

console.log('== 6. 代码片段 ==');
const snip = await api('GET', `/api/scans/${s1.id}/snippet?path=${encodeURIComponent(sample.filePath)}&start=${sample.startLine}&end=${sample.endLine}&issueId=${sample.id}`);
assert(snip.status === 200 && typeof snip.json.content === 'string' && snip.json.content.length > 0, '片段返回内容');
assert(snip.json.highlightedLines.includes(sample.startLine), '命中行已高亮');
assert(snip.json.source === 'file', '片段来自源码文件', snip.json.source);

console.log('== 7. 上传 v2 并以 v1 为基线扫描 ==');
const form2 = new FormData();
form2.append('file', new Blob([makeZip({ 'api.ts': SAMPLE_TS_V2 })], { type: 'application/zip' }), 'sample-v2.zip');
await api('POST', `/api/projects/${pid}/source`, form2);
const scan2 = await api('POST', `/api/projects/${pid}/scans`, { baselineScanId: s1.id });
assert(scan2.status === 201, 'v2 扫描已提交');
const s2 = await pollScan(scan2.json.id);
assert(s2.status === 'completed', 'v2 扫描完成', JSON.stringify(s2));
const { json: issues2 } = await api('GET', `/api/scans/${s2.id}/issues`);
const by = (st) => issues2.filter((i) => i.comparisonStatus === st).length;
console.log(`  v2 对比: new=${by('new')} fixed=${by('fixed')} remaining=${by('remaining')} 记录issueCount=${s2.issueCount}`);
assert(by('new') >= 1, '检测到新增问题（slackWebhookToken）');
assert(by('fixed') >= 1, '检测到已修复问题（eval 被移除）');
assert(s2.issueCount === by('new') + by('remaining'), 'issueCount 不含已修复');

console.log('== 7b. 上传按 .gitignore 忽略过滤（默认开启，可显式关闭） ==');
const makeIgnoreZip = () => {
  const zip = new AdmZip();
  zip.addFile('demo-src/.gitignore', Buffer.from('.env\ndist/\n*.log\n', 'utf8'));
  zip.addFile('demo-src/api.ts', Buffer.from(SAMPLE_TS_V1, 'utf8'));
  zip.addFile('demo-src/.env', Buffer.from('API_KEY=sk-xxx\n', 'utf8'));
  zip.addFile('demo-src/dist/bundle.js', Buffer.from('var x=1;\n', 'utf8'));
  zip.addFile('demo-src/debug.log', Buffer.from('log\n', 'utf8'));
  zip.addFile('demo-src/node_modules/pkg/index.js', Buffer.from('var y=2;\n', 'utf8'));
  return zip.toBuffer();
};
const igProject = (await api('POST', '/api/projects', { name: 'E2E-忽略过滤', language: 'TypeScript' })).json;
const igForm = new FormData();
igForm.append('file', new Blob([makeIgnoreZip()], { type: 'application/zip' }), 'ig.zip');
const igUp = await api('POST', `/api/projects/${igProject.id}/source`, igForm);
assert(igUp.status === 200, '忽略过滤上传成功', JSON.stringify(igUp.json));
// 保留：.gitignore + api.ts；忽略：secret.env + dist/ + debug.log（node_modules 强制剪除但不计数）
assert(igUp.json.fileCount === 2 && igUp.json.ignoredCount === 3,
  `默认过滤 fileCount=2 ignoredCount=3 (got ${igUp.json.fileCount}/${igUp.json.ignoredCount})`);
const igFormOff = new FormData();
igFormOff.append('file', new Blob([makeIgnoreZip()], { type: 'application/zip' }), 'ig-off.zip');
igFormOff.append('respectGitignore', 'false');
const igUpOff = await api('POST', `/api/projects/${igProject.id}/source`, igFormOff);
assert(igUpOff.status === 200 && igUpOff.json.fileCount === 6 && igUpOff.json.ignoredCount === 0,
  `关闭过滤保留全部 6 个文件 (got ${igUpOff.json.fileCount}/${igUpOff.json.ignoredCount})`);
const allIgnoredZip = new AdmZip();
allIgnoredZip.addFile('demo-src/.gitignore', Buffer.from('*\n', 'utf8'));
allIgnoredZip.addFile('demo-src/only.env', Buffer.from('A=1\n', 'utf8'));
const igFormAll = new FormData();
igFormAll.append('file', new Blob([allIgnoredZip.toBuffer()], { type: 'application/zip' }), 'ig-all.zip');
const igUpAll = await api('POST', `/api/projects/${igProject.id}/source`, igFormAll);
assert(igUpAll.status === 400, '全被忽略时返回 400', JSON.stringify(igUpAll.json));
await api('DELETE', `/api/projects/${igProject.id}`);

console.log('== 8. 测试报告 ==');
const report = await api('GET', `/api/scans/${s2.id}/report`);
assert(report.status === 200 && report.json?.totals, '报告 JSON 返回聚合数据');
assert(report.json.totals.total === s2.issueCount, '报告 total 与 issueCount 一致（不含已修复）',
  `${report.json.totals?.total} vs ${s2.issueCount}`);
const sevCount = (sev) => issues2.filter((i) => i.severity === sev && i.comparisonStatus !== 'fixed').length;
for (const sev of ['critical', 'high', 'medium', 'low']) {
  assert(report.json.totals.bySeverity[sev] === sevCount(sev), `报告严重度计数一致（${sev}）`,
    `${report.json.totals?.bySeverity?.[sev]} vs ${sevCount(sev)}`);
}
assert(report.json.totals.byComparison.new === by('new')
  && report.json.totals.byComparison.fixed === by('fixed')
  && report.json.totals.byComparison.remaining === by('remaining'), '报告对比计数一致');
assert(report.json.issues.length === issues2.length, '报告明细条数与 issues 接口一致');
assert(report.json.topRules.length > 0 && report.json.topFiles.length > 0, 'Top 规则/文件统计存在');
assert((report.json.conclusion ?? '').includes(s1.id), '结论文本含基线编号');

const reportHtmlRes = await fetch(`${BASE}/api/scans/${s2.id}/report?format=html`);
const reportHtml = await reportHtmlRes.text();
assert(reportHtmlRes.ok && reportHtml.includes('代码审计测试报告'), 'HTML 报告可生成');
assert(reportHtml.includes('风险分布') && reportHtml.includes('问题明细'), 'HTML 报告含关键章节');
assert(reportHtml.includes('已修复'), 'HTML 报告含基线已修复分组');
assert((reportHtmlRes.headers.get('content-disposition') ?? '').includes('attachment'), 'HTML 以附件形式下载');
const reportSummaryRes = await fetch(`${BASE}/api/scans/${s2.id}/report?format=html&detail=summary`);
const reportSummary = await reportSummaryRes.text();
assert(reportSummaryRes.ok && !reportSummary.includes('<pre>'), 'detail=summary 省略代码片段');

const badReport = await api('GET', '/api/scans/scan-不存在/report');
assert(badReport.status === 404, '不存在的扫描无报告');

console.log('== 9. 设为基线 ==');
const patched = await api('PATCH', `/api/projects/${pid}`, { baselineScanId: s1.id });
assert(patched.json.baselineScanId === s1.id, '项目基线已更新');
const badPatch = await api('PATCH', `/api/projects/${pid}`, { baselineScanId: 'scan-不存在' });
assert(badPatch.status === 400, '非法基线被拒绝');

console.log('== 10. 失败路径（legacy 规则目录模式 + 非法 YAML） ==');
// 服务端从 <server>/rules 解析 legacy 规则目录，这里必须写到同一位置（与进程 CWD 无关）
// 注意用 path 拼接：new URL('broken.yaml', dirUrl) 在目录 URL 缺尾斜杠时会错误地写到上一层
const brokenDir = path.join(import.meta.dirname, '..', 'rules', 'broken-rules-test');
fs.mkdirSync(brokenDir, { recursive: true });
fs.writeFileSync(path.join(brokenDir, 'broken.yaml'), 'rules: [ { id: [unclosed');
const badScan = await api('POST', `/api/projects/${pid}/scans`, { rules: 'broken-rules-test' });
const bad = await pollScan(badScan.json.id);
assert(bad.status === 'failed', '坏规则导致 failed', JSON.stringify(bad));
assert((bad.message ?? '').length > 0, '失败原因已回传', bad.message);
const failedReport = await api('GET', `/api/scans/${bad.id}/report`);
assert(failedReport.status === 400, '未完成扫描拒绝生成报告', JSON.stringify(failedReport.json));
fs.rmSync(brokenDir, { recursive: true, force: true });

console.log('== 11. 未上传就扫描 / 损坏 ZIP 被拒 ==');
const p2 = await api('POST', '/api/projects', { name: 'E2E-空项目', language: 'Java' });
const noSrc = await api('POST', `/api/projects/${p2.json.id}/scans`, {});
assert(noSrc.status === 400, '未上传源码时拒绝扫描');
const badZip = new FormData();
badZip.append('file', new Blob([Buffer.from('not a zip')], { type: 'application/zip' }), 'evil.zip');
const badUp = await api('POST', `/api/projects/${p2.json.id}/source`, badZip);
assert(badUp.status === 400, '损坏 ZIP 被拒绝');

console.log('== 11b. Git 仓库直扫：校验与失败路径 ==');
const badProto = await api('POST', `/api/projects/${p2.json.id}/clone`, { url: 'file:///etc/passwd' });
assert(badProto.status === 400, 'file:// 协议被拒绝', JSON.stringify(badProto.json));
const notUrl = await api('POST', `/api/projects/${p2.json.id}/clone`, { url: 'not a url' });
assert(notUrl.status === 400, '非法 URL 被拒绝');
const badRef = await api('POST', `/api/projects/${p2.json.id}/clone`, {
  url: 'https://github.com/octocat/Hello-World',
  ref: '--upload-pack=evil',
});
assert(badRef.status === 400, '注入式分支名被拒绝', JSON.stringify(badRef.json));
const emptyBody = await api('POST', `/api/projects/${p2.json.id}/clone`, {});
assert(emptyBody.status === 400, '缺少仓库地址被拒绝');
const unreachable = await api('POST', `/api/projects/${p2.json.id}/clone`, { url: 'http://127.0.0.1:9/no-repo.git' });
assert(
  unreachable.status === 400 && (unreachable.json?.error?.message ?? '').length > 0,
  '不可达仓库回传失败原因', JSON.stringify(unreachable.json),
);

await api('DELETE', `/api/projects/${p2.json.id}`);

console.log('== 12. 配置 CRUD 与规则包在线能力 ==');
const upd = await api('PUT', `/api/configs/${fullConfig.id}`, { ...fullConfig, excludes: ['demo-src/Vault.java'] });
assert(upd.status === 200 && upd.json.excludes.includes('demo-src/Vault.java'), '更新配置生效');
const cfgContent = await api('GET', `/api/rulepacks/${packJs.id}/content`);
assert(cfgContent.status === 200 && cfgContent.json.content.includes('js-hardcoded-secret'), '查看规则包 YAML 内容');
const edited = await api('PUT', `/api/rulepacks/${packJs.id}/content`, {
  content: PACK_JS_YAML.replace('Math.random()', 'Math.random() /* edited */'),
});
assert(edited.status === 200 && edited.json.ruleCount === 5, '在线编辑规则包并刷新规则条数', JSON.stringify(edited.json));
const editedContent = await api('GET', `/api/rulepacks/${packJs.id}/content`);
assert(editedContent.json.content.includes('/* edited */'), '编辑后的内容已落盘');
const badEdit = await api('PUT', `/api/rulepacks/${packJs.id}/content`, { content: 'rules: [ { broken' });
assert(badEdit.status === 400, '编辑非法 YAML 被拒绝');
const badEditRevert = await api('GET', `/api/rulepacks/${packJs.id}/content`);
assert(badEditRevert.json.content.includes('/* edited */'), '校验失败不落盘');

console.log('== 13. 排除路径联动 ==');
await api('PATCH', `/api/projects/${pid}`, { configId: fullConfig.id });
const scanEx = await api('POST', `/api/projects/${pid}/scans`, {});
const sEx = await pollScan(scanEx.json.id);
const { json: exIssues } = await api('GET', `/api/scans/${sEx.id}/issues`);
const javaCurrentHits = exIssues.filter(
  (i) => i.filePath.endsWith('.java') && i.comparisonStatus !== 'fixed',
);
assert(sEx.status === 'completed', '排除模式扫描完成', JSON.stringify(sEx));
assert(javaCurrentHits.length === 0, '被排除的 Java 文件零当前命中', `${javaCurrentHits.length}`);
assert(exIssues.length > 0, '未排除的 TS 文件仍正常命中', `${exIssues.length}`);

console.log('== 14. 停用规则包 / 删除规则包联动 ==');
await api('PATCH', `/api/projects/${pid}`, { configId: fullConfig.id });
await api('PATCH', `/api/rulepacks/${packJava.id}`, { enabled: false });
await api('PATCH', `/api/rulepacks/${packJs.id}`, { enabled: false });
const scanDisabled = await api('POST', `/api/projects/${pid}/scans`, {});
assert(scanDisabled.status === 400, '勾选包全部停用时拒绝扫描', JSON.stringify(scanDisabled.json));
await api('PATCH', `/api/rulepacks/${packJava.id}`, { enabled: true });
await api('PATCH', `/api/rulepacks/${packJs.id}`, { enabled: true });

const boundCfg = await createConfig({
  name: 'E2E-引用自定义包配置',
  rulePackIds: [onlinePack.json.id],
  excludes: [],
  includes: [],
  timeoutSeconds: 30,
  jobs: 4,
  maxTargetBytes: 5000000,
});
const delReferencedPack = await api('DELETE', `/api/rulepacks/${onlinePack.json.id}`);
assert(delReferencedPack.status === 204, '删除规则包成功');
const { json: configsAfterDelete } = await api('GET', '/api/configs');
const cfgAfter = configsAfterDelete.find((c) => c.id === boundCfg.id);
assert(cfgAfter && !cfgAfter.rulePackIds.includes(onlinePack.json.id), '删除包后配置勾选已移除');
await api('DELETE', `/api/configs/${boundCfg.id}`);

console.log('== 15. 删除项目 ==');
await api('DELETE', `/api/projects/${pid}`);
const after = await api('GET', `/api/projects/${pid}`);
assert(after.status === 404, '项目已删除');
const afterScans = await api('GET', `/api/scans/${s1.id}`);
assert(afterScans.status === 404, '级联删除扫描记录');

console.log('== 16. 收尾清理（测试自建的规则包与配置全部移除） ==');
await api('DELETE', `/api/rulepacks/${packJs.id}`);
await api('DELETE', `/api/rulepacks/${packJava.id}`);
await api('DELETE', `/api/configs/${fullConfig.id}`);
// 只断言 E2E 自建资源已清空；库中用户已有的配置/规则包原样保留
const finalConfigs = ((await api('GET', '/api/configs')).json ?? []).filter((c) => isE2eName(c.name));
const finalCustomPacks = ((await api('GET', '/api/rulepacks')).json ?? []).filter(
  (rp) => !rp.builtin && isE2eName(rp.name),
);
assert(finalConfigs.length === 0 && finalCustomPacks.length === 0, 'E2E 自建配置与自定义规则包已清理');

console.log('== 17. 规则实验室 ==');
const LAB_EVAL_RULE = `rules:
  - id: lab-eval
    languages: [javascript]
    message: 使用 eval 动态执行代码
    severity: WARNING
    pattern: eval(...)
`;
const labPass = await api('POST', '/api/rulelab/run', {
  yaml: LAB_EVAL_RULE,
  samples: {
    positive: 'function f(code) {\n  return eval(code);\n}\n',
    negative: 'const sum = new Function("a", "b", "return a + b");\n',
  },
});
assert(labPass.status === 200 && labPass.json.verdict === 'pass', '实验室：正例命中且反例无误报',
  JSON.stringify(labPass.json));
assert(
  labPass.json.positive.matches.length === 1 && labPass.json.positive.matches[0].startLine === 2,
  '命中行号与样本一致', JSON.stringify(labPass.json.positive.matches));
assert(labPass.json.language === 'javascript', '语言自动推断', labPass.json.language);
assert(labPass.json.ruleIds[0] === 'lab-eval' && labPass.json.positive.matches[0].ruleId === 'lab-eval',
  'checkId 前缀已剥离', JSON.stringify(labPass.json.ruleIds));

const labMiss = await api('POST', '/api/rulelab/run', {
  yaml: LAB_EVAL_RULE,
  samples: { positive: 'const a = 1;\n', negative: '' },
});
assert(labMiss.json.verdict === 'fail' && labMiss.json.failReasons.join().includes('正例未命中'),
  '漏报判为 fail', JSON.stringify(labMiss.json.failReasons));

const labFalse = await api('POST', '/api/rulelab/run', {
  yaml: LAB_EVAL_RULE,
  samples: { positive: '', negative: 'eval("1");\n' },
});
assert(labFalse.json.verdict === 'fail' && labFalse.json.failReasons.join().includes('误报'),
  '反例误报判为 fail', JSON.stringify(labFalse.json.failReasons));

const labBroken = await api('POST', '/api/rulelab/run', {
  yaml: 'rules: [ { broken',
  samples: { positive: 'x();\n', negative: '' },
});
assert(labBroken.json.verdict === 'error' && (labBroken.json.error ?? '').length > 0,
  '坏 YAML 返回 error 与原因', JSON.stringify(labBroken.json));

const labNoSample = await api('POST', '/api/rulelab/run', {
  yaml: LAB_EVAL_RULE,
  samples: { positive: '   ', negative: '' },
});
assert(labNoSample.json.verdict === 'error' && (labNoSample.json.error ?? '').includes('样本'),
  '空样本返回 error', JSON.stringify(labNoSample.json));

const labTaint = await api('POST', '/api/rulelab/run', {
  yaml: `rules:
  - id: lab-taint-eval
    languages: [javascript]
    message: 不可信输入进入 eval 执行
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: req.query
    pattern-sinks:
      - pattern: eval(...)
`,
  samples: {
    positive: 'function handle(req) {\n  eval(req.query.code);\n}\n',
    negative: 'function handle() {\n  eval("1 + 1");\n}\n',
  },
});
assert(labTaint.json.verdict === 'pass', 'taint 规则实验室通过', JSON.stringify(labTaint.json));

console.log('== 18. 可移植规则包：导入 / 检查 / 导出回流 / 扫描 ==');
function packZipForm(zip, name = 'e2e-pack.zip') {
  const form = new FormData();
  form.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), name);
  return form;
}

const portablePack = new AdmZip();
portablePack.addFile('pack.yaml', Buffer.from(
  'name: E2E-可移植包\nversion: 1.2.0\ndescription: 端到端测试用规则包\nlicense: MIT\nframeworks: [express]\ncwe: ["CWE-95"]\nowasp: ["A03:2021"]\n',
  'utf8',
));
portablePack.addFile('rules/eval.yaml', Buffer.from(LAB_EVAL_RULE, 'utf8'));
portablePack.addFile('samples/lab-eval/positive.js', Buffer.from('function f(code) {\n  return eval(code);\n}\n', 'utf8'));
portablePack.addFile('samples/lab-eval/negative.js', Buffer.from('const sum = new Function("a", "b", "return a + b");\n', 'utf8'));
const imported = await api('POST', '/api/rulepacks/import', packZipForm(portablePack));
assert(
  imported.status === 201 && imported.json.version === '1.2.0'
    && imported.json.ruleCount === 1 && imported.json.sampleCount === 2 && imported.json.isDir === true,
  '导入可移植包（版本/规则数/样本数）', JSON.stringify(imported.json));
assert(imported.json.manifest?.frameworks?.[0] === 'express' && imported.json.manifest?.cwe?.[0] === 'CWE-95',
  '清单字段入库', JSON.stringify(imported.json.manifest));

// 目录包参与扫描：绑定配置 → 扫描 demo 源码 → 应有命中
const packProject = await makeProjectWithSource('E2E-目录包扫描项目');
const packCfg = await createConfig({
  name: 'E2E-目录包配置',
  rulePackIds: [imported.json.id],
  excludes: [], includes: [], timeoutSeconds: 30, jobs: 4, maxTargetBytes: 5000000,
});
await api('PATCH', `/api/projects/${packProject}`, { configId: packCfg.id });
const packScan = await api('POST', `/api/projects/${packProject}/scans`, {});
const packScanDone = await pollScan(packScan.json.id);
assert(packScanDone.status === 'completed' && packScanDone.issueCount > 0,
  '目录式规则包可正常参与扫描', JSON.stringify(packScanDone));

console.log('== 18b. SARIF 导出与可复现清单 ==');
const sarifRes = await api('GET', `/api/scans/${packScanDone.id}/sarif`);
const sarif = sarifRes.json;
assert(sarifRes.status === 200 && sarif.version === '2.1.0' && Array.isArray(sarif.runs),
  'SARIF 2.1.0 结构', JSON.stringify(sarif?.version));
const sarifResults = sarif.runs?.[0]?.results ?? [];
const sarifRules = sarif.runs?.[0]?.tool?.driver?.rules ?? [];
assert(sarifResults.length === packScanDone.issueCount,
  `SARIF results 数与 issueCount 一致 (${sarifResults.length} vs ${packScanDone.issueCount})`);
assert(sarifRules.length > 0 && sarifRules.every((r) => typeof r.id === 'string'),
  'SARIF rules 去重登记', JSON.stringify(sarifRules.map((r) => r.id)));
const sarifFirst = sarifResults[0];
assert(
  ['error', 'warning', 'note'].includes(sarifFirst.level)
    && typeof sarifFirst.locations?.[0]?.physicalLocation?.region?.startLine === 'number'
    && (sarifFirst.partialFingerprints?.['opengrepFingerprint/v1'] ?? '').length > 0,
  'SARIF 单条结果含 level/位置/指纹', JSON.stringify(sarifFirst));
const levelBySeverity = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };
const sarifIssue = (await api('GET', `/api/scans/${packScanDone.id}/issues`)).json[0];
assert(sarifFirst.level === levelBySeverity[sarifIssue.severity],
  `严重度映射一致 (${sarifIssue.severity} → ${sarifFirst.level})`);

const manifest = (await api('GET', `/api/scans/${packScanDone.id}/manifest`)).json;
assert(
  typeof manifest.source?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(manifest.source.sha256),
  'manifest 源码 SHA-256', JSON.stringify(manifest.source));
assert(
  typeof manifest.commandLine === 'string' && manifest.commandLine.includes(' scan '),
  'manifest 引擎命令行', manifest.commandLine);
assert(
  Array.isArray(manifest.config?.ruleFiles) && manifest.config.ruleFiles.length > 0
    && manifest.config.ruleFiles.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)),
  'manifest 规则文件哈希', JSON.stringify(manifest.config?.ruleFiles));
assert(manifest.engine?.name === 'opengrep' && Boolean(manifest.engine?.version),
  'manifest 引擎版本', JSON.stringify(manifest.engine));
const scanRecord = (await api('GET', `/api/scans/${packScanDone.id}`)).json;
assert(scanRecord.srcHash === manifest.source.sha256, '扫描记录与 manifest 哈希一致');

console.log('== 18c. SARIF 导入：导出 → 导入往返 + 基线对比 ==');
const roundtripForm = new FormData();
roundtripForm.append('file', new Blob([JSON.stringify(sarif)], { type: 'application/json' }), 'roundtrip.sarif');
roundtripForm.append('baselineScanId', packScanDone.id);
const importedScan = await api('POST', `/api/projects/${packProject}/sarif`, roundtripForm);
assert(importedScan.status === 201 && importedScan.json.status === 'completed',
  'SARIF 导入生成已完成扫描', JSON.stringify(importedScan.json));
assert((importedScan.json.rules ?? '').startsWith('SARIF 导入（'),
  '扫描记录标注导入来源与工具名', importedScan.json.rules);
const { json: importedIssues } = await api('GET', `/api/scans/${importedScan.json.id}/issues`);
assert(importedIssues.length === sarifResults.length,
  `导入 issue 数与 SARIF results 一致 (${importedIssues.length} vs ${sarifResults.length})`);
assert(importedIssues.every((i) => i.comparisonStatus === 'remaining'),
  '同指纹对基线判为遗留', JSON.stringify(importedIssues.map((i) => i.comparisonStatus)));
assert(importedIssues[0].severity === sarifIssue.severity,
  `severity 往返无损 (${sarifIssue.severity})`, importedIssues[0].severity);
assert(importedIssues[0].filePath === sarifIssue.filePath && importedIssues[0].startLine === sarifIssue.startLine,
  '路径与行号往返无损', `${importedIssues[0].filePath}:${importedIssues[0].startLine}`);

const badSarif = new FormData();
badSarif.append('file', new Blob(['{"not":"sarif"}'], { type: 'application/json' }), 'bad.sarif');
const badSarifRes = await api('POST', `/api/projects/${packProject}/sarif`, badSarif);
assert(badSarifRes.status === 400, '非 SARIF 的 JSON 被拒绝', JSON.stringify(badSarifRes.json));
const badExt = new FormData();
badExt.append('file', new Blob([JSON.stringify(sarif)], { type: 'application/json' }), 'evil.txt');
const badExtRes = await api('POST', `/api/projects/${packProject}/sarif`, badExt);
assert(badExtRes.status === 400, '非 .sarif/.json 扩展名被拒绝');
const badBaseline = new FormData();
badBaseline.append('file', new Blob([JSON.stringify(sarif)], { type: 'application/json' }), 'b.sarif');
badBaseline.append('baselineScanId', 'scan-不存在');
const badBaselineRes = await api('POST', `/api/projects/${packProject}/sarif`, badBaseline);
assert(badBaselineRes.status === 400, '非法基线被拒绝', JSON.stringify(badBaselineRes.json));

const packCheck = await api('POST', `/api/rulepacks/${imported.json.id}/check`);
assert(
  packCheck.status === 200 && packCheck.json.tier === 'verified'
    && packCheck.json.items[0].verdict === 'pass',
  '质量检查 verified', JSON.stringify(packCheck.json));
const packAfterCheck = (await api('GET', '/api/rulepacks')).json.find((rp) => rp.id === imported.json.id);
assert(packAfterCheck?.lastCheck?.tier === 'verified' && packAfterCheck.lastCheck.passed === 1,
  '检查结果已存为 lastCheck', JSON.stringify(packAfterCheck?.lastCheck));

const exportedRes = await fetch(`${BASE}/api/rulepacks/${imported.json.id}/export`);
assert(exportedRes.ok && (exportedRes.headers.get('content-disposition') ?? '').includes('attachment'),
  '导出 zip 为附件下载');
const exportBytes = Buffer.from(await exportedRes.arrayBuffer());
const exportedZip = new AdmZip(exportBytes);
const exportedNames = exportedZip.getEntries().map((entry) => entry.entryName);
assert(exportedNames.some((name) => /\/README\.md$/i.test(name)),
  '目录包导出注入贡献规范 README.md', exportedNames.join(' | '));
assert(exportedNames.some((name) => /pack\.yaml$/i.test(name)), '导出 zip 含 pack.yaml 清单');
const exportedReadme = exportedZip.getEntries().find((entry) => /\/README\.md$/i.test(entry.entryName));
const exportedReadmeText = exportedReadme.getData().toString('utf8');
assert(
  exportedReadmeText.includes('E2E-可移植包') && exportedReadmeText.includes('lab-eval')
    && exportedReadmeText.includes('semgrep-rules'),
  'README 含包名/规则清单/许可红线声明');
const reImported = await api('POST', '/api/rulepacks/import',
  packZipForm(AdmZip(exportBytes), 'repack.zip'));
assert(reImported.status === 201 && reImported.json.sampleCount === 2 && reImported.json.version === '1.2.0',
  '导出的 zip 可回流导入', JSON.stringify(reImported.json));

const badManifest = new AdmZip();
badManifest.addFile('pack.yaml', Buffer.from('name: [broken', 'utf8'));
badManifest.addFile('rules/r.yaml', Buffer.from(LAB_EVAL_RULE, 'utf8'));
const badImported = await api('POST', '/api/rulepacks/import', packZipForm(badManifest, 'bad.zip'));
assert(badImported.status === 400 && (badImported.json?.error?.message ?? '').includes('pack.yaml'),
  '坏 pack.yaml 被拒绝', JSON.stringify(badImported.json));

const multiYaml = new AdmZip();
multiYaml.addFile('a.yaml', Buffer.from(LAB_EVAL_RULE, 'utf8'));
multiYaml.addFile('b.yaml', Buffer.from(LAB_EVAL_RULE.replace('lab-eval', 'lab-eval-2'), 'utf8'));
const multiImported = await api('POST', '/api/rulepacks/import', packZipForm(multiYaml, 'multi.zip'));
assert(multiImported.status === 400 && (multiImported.json?.error?.message ?? '').includes('pack.yaml'),
  '无清单多 YAML 被拒绝并提示格式', JSON.stringify(multiImported.json));

const basicPack = new AdmZip();
basicPack.addFile('pack.yaml', Buffer.from('name: E2E-无样本包\nversion: 0.3.0\n', 'utf8'));
basicPack.addFile('rules/eval.yaml', Buffer.from(LAB_EVAL_RULE, 'utf8'));
const basicImported = await api('POST', '/api/rulepacks/import', packZipForm(basicPack, 'basic.zip'));
assert(basicImported.status === 201 && basicImported.json.sampleCount === 0,
  '无样本包导入为 basic', JSON.stringify(basicImported.json));
const basicCheck = await api('POST', `/api/rulepacks/${basicImported.json.id}/check`);
assert(basicCheck.json.tier === 'basic' && basicCheck.json.items[0].verdict === 'unverified',
  '无样本包检查为 basic/unverified', JSON.stringify(basicCheck.json));
const basicExport = await fetch(`${BASE}/api/rulepacks/${basicImported.json.id}/export`);
const basicZip = new AdmZip(Buffer.from(await basicExport.arrayBuffer()));
assert(basicZip.getEntries().some((entry) => /\/?README\.md$/i.test(entry.entryName)),
  '单文件包导出也注入 README.md', basicZip.getEntries().map((e) => e.entryName).join(' | '));

// 收尾：删除本节自建的项目 / 配置 / 规则包
await api('DELETE', `/api/projects/${packProject}`);
await api('DELETE', `/api/configs/${packCfg.id}`);
for (const id of [imported.json.id, reImported.json.id, basicImported.json.id]) {
  await api('DELETE', `/api/rulepacks/${id}`);
}

console.log('== 19. 实验室样本随包保存（另存为新规则包 → 质量检查回归） ==');
const labSavedPack = await api('POST', '/api/rulepacks', {
  name: 'E2E-实验室样本包',
  language: 'JavaScript',
  content: LAB_EVAL_RULE,
  samples: {
    positive: 'function f(code) {\n  return eval(code);\n}\n',
    negative: 'const sum = new Function("a", "b", "return a + b");\n',
  },
});
assert(
  labSavedPack.status === 201 && labSavedPack.json.isDir === true
    && labSavedPack.json.ruleCount === 1 && labSavedPack.json.sampleCount === 2,
  '带样本创建 → 可移植目录包', JSON.stringify(labSavedPack.json));
const labSavedCheck = await api('POST', `/api/rulepacks/${labSavedPack.json.id}/check`);
assert(
  labSavedCheck.status === 200 && labSavedCheck.json.tier === 'verified'
    && labSavedCheck.json.summary?.passed === 1,
  '样本包一键质量检查 verified', JSON.stringify(labSavedCheck.json));
await api('DELETE', `/api/rulepacks/${labSavedPack.json.id}`);
const { json: packsAfterLab } = await api('GET', '/api/rulepacks');
assert(!packsAfterLab.some((rp) => rp.id === labSavedPack.json.id),
  '实验室样本包已清理（不留测试残留）');

console.log('== 20. P1 批次：人工复核证据链 / 双快照对比 / 规则知识库 / 污点链 ==');
const p20pack = await uploadPack('E2E-P1批次规则包', 'JavaScript', PACK_JS_YAML);
const p20cfg = await createConfig({
  name: 'E2E-P1批次配置',
  rulePackIds: [p20pack.id],
  excludes: [], includes: [], timeoutSeconds: 30, jobs: 4, maxTargetBytes: 5000000,
});
const p20proj = await makeProjectWithSource('E2E-P1批次项目');
await api('PATCH', `/api/projects/${p20proj}`, { configId: p20cfg.id });
const p20scanA = await pollScan((await api('POST', `/api/projects/${p20proj}/scans`, {})).json.id);
assert(p20scanA.status === 'completed' && p20scanA.issueCount > 0, 'P1 项目扫描 A 完成', JSON.stringify(p20scanA));

// 20.1 人工复核：设置 → 问题接口带回 → 第二次扫描自动继承（fingerprint 键）→ 报告统计
const { json: issuesA } = await api('GET', `/api/scans/${p20scanA.id}/issues`);
const reviewTarget = issuesA[0];
assert(Boolean(reviewTarget.fingerprint), 'issues 返回 fingerprint', JSON.stringify(reviewTarget));
const putReview = await api('PUT', `/api/projects/${p20proj}/reviews`, {
  fingerprint: reviewTarget.fingerprint,
  status: 'false_positive',
  reason: 'E2E：该凭据为测试占位符，不构成真实风险',
  reviewer: 'e2e-reviewer',
});
assert(putReview.status === 200 && putReview.json.status === 'false_positive', '设置复核结论', JSON.stringify(putReview.json));
const badReview = await api('PUT', `/api/projects/${p20proj}/reviews`, {
  fingerprint: reviewTarget.fingerprint, status: 'bogus',
});
assert(badReview.status === 400, '非法复核状态被拒绝');
const { json: issuesA2 } = await api('GET', `/api/scans/${p20scanA.id}/issues`);
const reviewedIssue = issuesA2.find((issue) => issue.fingerprint === reviewTarget.fingerprint);
assert(
  reviewedIssue?.review?.status === 'false_positive' && reviewedIssue.review.reviewer === 'e2e-reviewer',
  'issues 接口带复核结论', JSON.stringify(reviewedIssue?.review));
const p20scanB = await pollScan((await api('POST', `/api/projects/${p20proj}/scans`, {})).json.id);
const { json: issuesB } = await api('GET', `/api/scans/${p20scanB.id}/issues`);
const inherited = issuesB.find((issue) => issue.fingerprint === reviewTarget.fingerprint);
assert(inherited?.review?.status === 'false_positive', '复核结论跨扫描继承（重扫不丢失）', JSON.stringify(inherited?.review));
const p20report = await api('GET', `/api/scans/${p20scanB.id}/report`);
assert(
  p20report.json?.reviewStats?.reviewed >= 1 && p20report.json.reviewStats.falsePositives >= 1,
  '报告含复核统计', JSON.stringify(p20report.json?.reviewStats));
assert((p20report.json?.conclusion ?? '').includes('人工复核'), '报告结论含复核句');

// 20.2 双快照对比：同源对比 + 版本演进对比（含跨扫描指纹与文件行级统计）
const diffSame = await api('GET', `/api/scans/${p20scanB.id}/diff?against=${p20scanA.id}`);
assert(diffSame.status === 200, '同源对比可用', JSON.stringify(diffSame.json));
assert(
  diffSame.json.issueDiff.new.count === 0 && diffSame.json.issueDiff.fixed.count === 0
    && diffSame.json.issueDiff.remaining.count === p20scanA.issueCount,
  '同源对比：无新增无修复，全部遗留', JSON.stringify(diffSame.json.issueDiff));
const formV2 = new FormData();
formV2.append('file', new Blob([makeZip({ 'api.ts': SAMPLE_TS_V2 })], { type: 'application/zip' }), 'p1-v2.zip');
await api('POST', `/api/projects/${p20proj}/source`, formV2);
const p20scanC = await pollScan((await api('POST', `/api/projects/${p20proj}/scans`, {})).json.id);
const diffV2 = await api('GET', `/api/scans/${p20scanC.id}/diff?against=${p20scanA.id}`);
assert(diffV2.json.issueDiff.new.count >= 1 && diffV2.json.issueDiff.fixed.count >= 1,
  '版本演进对比：检测到新增与修复', JSON.stringify(diffV2.json.issueDiff));
const modifiedApi = diffV2.json.fileDiff.modified.find((file) => file.path.endsWith('api.ts'));
assert(
  Boolean(modifiedApi) && modifiedApi.diffable && modifiedApi.addedLines >= 1,
  '文件级 diff：api.ts 修改并统计行级变更', JSON.stringify(modifiedApi));
const diffSelf = await api('GET', `/api/scans/${p20scanC.id}/diff?against=${p20scanC.id}`);
assert(diffSelf.status === 400, '对比自身被拒绝');
const diffMissing = await api('GET', `/api/scans/${p20scanC.id}/diff?against=scan-不存在`);
assert(diffMissing.status === 404, '对比目标不存在返回 404');

// 20.3 规则知识库：CWE 中文名 + 修复建议 + 命中统计 + 内置规则中文说明与溯源
const kb = await api('GET', '/api/rules/knowledge/js-hardcoded-secret');
assert(kb.status === 200 && kb.json.found === true && kb.json.matchedRuleId === 'js-hardcoded-secret',
  '知识库命中自定义规则', JSON.stringify(kb.json));
assert(
  kb.json.cwe.some((item) => item.id === 'CWE-798' && (item.name ?? '').includes('硬编码')),
  'CWE 中文名映射', JSON.stringify(kb.json.cwe));
assert((kb.json.fixSuggestion ?? '').length > 0, 'CWE 级修复建议');
assert(kb.json.stats.total >= 1, '命中统计', JSON.stringify(kb.json.stats));
const kbUpstream = await api('GET', '/api/rules/knowledge/aead-no-final');
assert((kbUpstream.json?.upstreamUrl ?? '').includes('opengrep-rules/tree/main/'),
  '内置规则上游溯源链接', kbUpstream.json?.upstreamUrl);
assert((kbUpstream.json?.zhMessage ?? '').length > 0, '内置规则含中文说明', kbUpstream.json?.zhMessage);
assert(
  kbUpstream.json?.cwe?.some((item) => (item.name ?? '').length > 0) === true,
  '内置规则 CWE 中文名', JSON.stringify(kbUpstream.json?.cwe));

// 20.4 污点链：实验室 taint 命中带传播链
const labTaintFlow = await api('POST', '/api/rulelab/run', {
  yaml: `rules:
  - id: p1-taint-eval
    languages: [javascript]
    message: 不可信输入进入 eval 执行
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: req.query
    pattern-sinks:
      - pattern: eval(...)
`,
  samples: {
    positive: 'function handle(req) {\n  const code = req.query.code;\n  eval(code);\n}\n',
    negative: '',
  },
});
assert(labTaintFlow.json.verdict === 'pass', '污点实验通过', JSON.stringify(labTaintFlow.json));
const taintMatch = labTaintFlow.json.positive.matches[0];
assert(
  Array.isArray(taintMatch.taintFlow) && taintMatch.taintFlow.length >= 2
    && taintMatch.taintFlow[0].role === 'source' && taintMatch.taintFlow.at(-1).role === 'sink'
    && taintMatch.taintFlow.some((step) => step.role === 'intermediate'),
  '实验室命中带污点传播链（source→intermediate→sink）', JSON.stringify(taintMatch.taintFlow));

// 收尾
await api('DELETE', `/api/projects/${p20proj}`);
await api('DELETE', `/api/configs/${p20cfg.id}`);
await api('DELETE', `/api/rulepacks/${p20pack.id}`);

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
