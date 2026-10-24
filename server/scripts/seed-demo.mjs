/**
 * 测试数据种子脚本：通过真实 REST API 造一套完整演示数据。
 * 产物全部落在 server/data/ 与 server/rules/custom/（均在 .gitignore 中，不会入库）。
 * 用法：node server/scripts/seed-demo.mjs [--skip-clone]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8787';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(HERE, 'seed-src');
const SKIP_CLONE = process.argv.includes('--skip-clone');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function j(pathname, init) {
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${pathname} -> HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}
const post = (data) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

const PACKS = [
  {
    name: '企业内检-硬编码凭据',
    language: 'JavaScript',
    content: `rules:
  - id: corp-js-hardcoded-credential
    message: 硬编码口令/密钥赋值（企业内检基线）
    severity: ERROR
    languages: [javascript, typescript]
    metadata:
      security-severity: "9.0"
      category: security
    patterns:
      - pattern-either:
          - pattern: const $VAR = "..."
          - pattern: let $VAR = "..."
          - pattern: var $VAR = "..."
      - metavariable-regex:
          metavariable: $VAR
          regex: (?i).*(password|secret|token|api_?key|apikey|access_?key).*
`,
  },
  {
    name: '企业内检-弱加密与不安全随机',
    language: 'JavaScript',
    content: `rules:
  - id: corp-js-weak-hash
    message: 使用 MD5/SHA1 弱哈希算法
    severity: WARNING
    languages: [javascript, typescript]
    metadata:
      security-severity: "5.5"
    pattern-either:
      - pattern: crypto.createHash("md5")
      - pattern: crypto.createHash('md5')
      - pattern: crypto.createHash("sha1")
      - pattern: crypto.createHash('sha1')
  - id: corp-js-insecure-random
    message: 使用 Math.random() 生成令牌/验证码等安全敏感值
    severity: WARNING
    languages: [javascript, typescript]
    metadata:
      security-severity: "6.0"
    pattern-either:
      - pattern: const $T = Math.random()
      - pattern: let $T = Math.random()
      - pattern: var $T = Math.random()
      - pattern: $T = Math.random()
`,
  },
  {
    name: '企业内检-Python危险模式',
    language: 'Python',
    content: `rules:
  - id: corp-py-dynamic-exec
    message: eval()/exec() 动态执行代码
    severity: ERROR
    languages: [python]
    pattern-either:
      - pattern: eval(...)
      - pattern: exec(...)
  - id: corp-py-pickle-load
    message: pickle 反序列化不可信数据
    severity: ERROR
    languages: [python]
    pattern-either:
      - pattern: pickle.loads(...)
      - pattern: pickle.load(...)
  - id: corp-py-sql-concat
    message: SQL 语句字符串拼接（疑似注入点）
    severity: ERROR
    languages: [python]
    pattern-either:
      - pattern: $CUR.execute("..." + $X)
      - pattern: $CUR.execute("..." + $X + "...")
  - id: corp-py-weak-hash
    message: 使用 MD5/SHA1 弱哈希
    severity: WARNING
    languages: [python]
    pattern-either:
      - pattern: hashlib.md5(...)
      - pattern: hashlib.sha1(...)
  - id: corp-py-hardcoded-secret
    message: 硬编码口令/密钥赋值
    severity: ERROR
    languages: [python]
    metadata:
      security-severity: "9.0"
    patterns:
      - pattern-either:
          - pattern: $VAR = "..."
          - pattern: $VAR = '...'
      - metavariable-regex:
          metavariable: $VAR
          regex: (?i).*(password|secret|token|api_?key|apikey).*
`,
  },
];

function makeTar(dirName) {
  const tarName = `${dirName}.tgz`;
  execSync(`tar czf "${tarName}" -C "${dirName}" .`, { cwd: SEED_DIR, shell: 'bash' });
  return path.join(SEED_DIR, tarName);
}

async function uploadSource(projectId, tarPath) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(tarPath)]), path.basename(tarPath));
  return j(`/api/projects/${projectId}/source`, { method: 'POST', body: fd });
}

async function scanAndWait(projectId, label) {
  const scan = await j(`/api/projects/${projectId}/scans`, post({}));
  console.log(`  [scan] ${label} 发起：${scan.id}`);
  for (let i = 0; i < 240; i++) {
    await sleep(3000);
    const s = await j(`/api/scans/${scan.id}`);
    if (s.status === 'completed') {
      console.log(`  [scan] ${label} 完成：${s.issueCount} 个问题`);
      return s;
    }
    if (s.status === 'failed') {
      throw new Error(`${label} 扫描失败：${s.message ?? '未知原因'}`);
    }
  }
  throw new Error(`${label} 扫描超时`);
}

const log = (msg) => console.log(msg);

async function main() {
  // ① 健康检查
  const health = await j('/api/health');
  if (!health.ok) throw new Error('引擎不可用，先运行 npm run setup:engine');
  log(`引擎就绪：v${health.engineVersion}（${health.engineSource}）`);

  // ② 自定义规则包
  log('\n== 创建自定义规则包 ==');
  const existingPacks = await j('/api/rulepacks');
  for (const pack of PACKS) {
    if (existingPacks.some((p) => p.name === pack.name)) {
      log(`  已存在，跳过：${pack.name}`);
      continue;
    }
    const created = await j('/api/rulepacks', post(pack));
    log(`  创建：${created.name}（${created.ruleCount} 条规则）`);
  }

  // ③ 扫描配置：内置（启用中）+ 全部自定义包
  const packs = await j('/api/rulepacks');
  const rulePackIds = packs.filter((p) => p.builtin ? p.enabled : true).map((p) => p.id);
  const CONFIG_NAME = '全量审计-内置与企业内检';
  let configs = await j('/api/configs');
  let config = configs.find((c) => c.name === CONFIG_NAME);
  if (!config) {
    config = await j('/api/configs', post({
      name: CONFIG_NAME,
      description: '种子数据配置：全部启用的内置规则包 + 3 个企业内检自定义包',
      rulePackIds,
      excludes: [],
      includes: [],
      timeoutSeconds: 30,
      jobs: 4,
      maxTargetBytes: 5_000_000,
    }));
    log(`\n== 创建扫描配置 ==\n  ${config.name}（勾选 ${rulePackIds.length} 个规则包）`);
  } else {
    log(`\n== 扫描配置已存在：${config.name} ==`);
  }

  // ④ 项目一：nodejs 支付演示（两轮扫描，验证基线对比）
  log('\n== 项目一：demo-nodejs-payment ==');
  let projects = await j('/api/projects');
  let p1 = projects.find((p) => p.name === 'demo-nodejs-payment');
  if (!p1) p1 = await j('/api/projects', post({ name: 'demo-nodejs-payment', description: '种子数据：Node.js 支付服务演示（故意包含硬编码密钥 / MD5 / eval / SQL 拼接）' }));
  await j(`/api/projects/${p1.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configId: config.id }) });
  const tar1 = makeTar('nodejs-v1');
  log(`  上传 v1 源码：${(await uploadSource(p1.id, tar1)).fileCount} 个文件`);
  const s1 = await scanAndWait(p1.id, 'v1 基线扫描');
  await j(`/api/projects/${p1.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baselineScanId: s1.id }) });
  log('  已设为项目基线');
  const tar2 = makeTar('nodejs-v2');
  log(`  上传 v2 源码（修复 eval、新增 backupApiKey / csrfToken）：${(await uploadSource(p1.id, tar2)).fileCount} 个文件`);
  const s2 = await scanAndWait(p1.id, 'v2 对比扫描');

  // ⑤ 人工复核证据（在 v2 扫描结果上留三种结论）
  const issues2 = await j(`/api/scans/${s2.id}/issues`);
  const pick = (regex) => issues2.find((issue) => regex.test(issue.ruleId) && issue.fingerprint);
  const confirmIssue = pick(/hardcoded/i);
  const fpIssue = pick(/insecure-random|weak-hash/i);
  const acceptIssue = pick(/weak-hash|pickle|dynamic-exec|sql/i);
  const review = (issue, payload) =>
    j(`/api/projects/${p1.id}/reviews`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: issue.fingerprint, reviewer: 'lyf', ...payload }),
    });
  if (confirmIssue) {
    await review(confirmIssue, { status: 'confirmed', reason: '密钥硬编码属实，需接入 KMS 重构' });
    log(`  复核-已确认：${confirmIssue.ruleId}`);
  }
  if (fpIssue) {
    await review(fpIssue, { status: 'false_positive', reason: '演示页 nonce，不参与鉴权，可接受' });
    log(`  复核-误报：${fpIssue.ruleId}`);
  }
  if (acceptIssue && acceptIssue.fingerprint !== confirmIssue?.fingerprint && acceptIssue.fingerprint !== fpIssue?.fingerprint) {
    await review(acceptIssue, { status: 'accepted', reason: '历史算法兼容旧数据，已列入季度改造计划' });
    log(`  复核-有条件接受：${acceptIssue.ruleId}`);
  }

  // ⑥ 项目二：python flask 演示
  log('\n== 项目二：demo-python-flask-blog ==');
  projects = await j('/api/projects');
  let p2 = projects.find((p) => p.name === 'demo-python-flask-blog');
  if (!p2) p2 = await j('/api/projects', post({ name: 'demo-python-flask-blog', description: '种子数据：Flask 博客演示（SQL 拼接 / pickle 反序列化 / eval / 弱哈希）' }));
  await j(`/api/projects/${p2.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configId: config.id }) });
  const tar3 = makeTar('python-v1');
  log(`  上传源码：${(await uploadSource(p2.id, tar3)).fileCount} 个文件`);
  await scanAndWait(p2.id, 'flask 扫描');

  // ⑦ 项目三：GitHub 真实仓库
  if (!SKIP_CLONE) {
    log('\n== 项目三：真实开源仓库克隆 ==');
    projects = await j('/api/projects');
    let p3 = projects.find((p) => p.name === 'real-express');
    if (!p3) p3 = await j('/api/projects', post({ name: 'real-express', description: '种子数据：GitHub expressjs/express 浅克隆（真实代码基线）' }));
    await j(`/api/projects/${p3.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ configId: config.id }) });
    const candidates = [
      'https://github.com/expressjs/express',
      'https://gitee.com/mirrors/express',
    ];
    let cloned = false;
    for (const url of candidates) {
      try {
        log(`  尝试克隆：${url}`);
        const cloneRes = await j(`/api/projects/${p3.id}/clone`, post({ url }));
        log(`  克隆完成：${cloneRes?.fileCount ?? '?'} 个文件`);
        cloned = true;
        break;
      } catch (error) {
        log(`  克隆失败（${String(error.message).slice(0, 120)}），尝试下一个…`);
      }
    }
    if (cloned) {
      await scanAndWait(p3.id, 'express 扫描');
    } else {
      log('  全部克隆源失败，跳过该项目扫描（可稍后在页面手动上传）');
    }
  }

  // ⑧ 汇总
  const [finalProjects, finalScans] = await Promise.all([j('/api/projects'), j('/api/scans')]);
  log('\n== 种子数据汇总 ==');
  log(`项目 ${finalProjects.length} 个：${finalProjects.map((p) => p.name).join('、')}`);
  log(`扫描 ${finalScans.length} 次：${finalScans.map((s) => `${s.status}(${s.issueCount ?? '-'})`).join('、')}`);
  log('完成。所有数据落在 server/data/（.gitignore 已忽略）。');
}

main().catch((error) => {
  console.error('种子脚本失败：', error.message);
  process.exit(1);
});
