# -*- coding: utf-8 -*-
"""一次性脚本：其余模块错误码化（engine-update / git-clone / sarif-import / scan-runner / rule-lab / pack-format）（跑完即删）"""
import io

def patch(path, blocks, import_line=None, import_anchor=None):
    s = io.open(path, encoding='utf-8').read()
    if import_line and import_line not in s:
        assert import_anchor in s, path + ': anchor missing'
        s = s.replace(import_anchor, import_anchor + '\n' + import_line, 1)
    miss = 0
    for o, n in blocks:
        if o not in s:
            print(f'{path} MISS:', o[:70].replace('\n', '\\n'))
            miss += 1
        s = s.replace(o, n, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print(path, 'miss:', miss)

# ---------- engine-update.ts ----------
patch('engine-update.ts', [
("""  if (upgradePending) throw new HttpError(409, '引擎升级正在进行中，请稍候');""",
 """  if (upgradePending) {
    throw new HttpError(409, '引擎升级正在进行中，请稍候', { code: 'srv.upgradePending' });
  }"""),
("""      throw new HttpError(409, info.reason ?? '当前没有可升级的版本');""",
 """      throw new HttpError(409, info.reason ?? '当前没有可升级的版本', {
        code: 'srv.noUpgradeTarget',
      });"""),
])

# ---------- git-clone.ts ----------
patch('git-clone.ts', [
("""    throw new HttpError(400, '仓库地址格式不正确，请输入 https:// 开头的 Git 仓库 URL');""",
 """    throw new HttpError(400, '仓库地址格式不正确，请输入 https:// 开头的 Git 仓库 URL', {
      code: 'git.badUrl',
    });"""),
("""    throw new HttpError(400, '仅支持 http(s):// 形式的 Git 仓库地址');""",
 """    throw new HttpError(400, '仅支持 http(s):// 形式的 Git 仓库地址', { code: 'git.schemeUnsupported' });"""),
("""    throw new HttpError(400, '分支/Tag 名称只允许字母、数字与 . _ / - 字符，且不能以点开头');""",
 """    throw new HttpError(400, '分支/Tag 名称只允许字母、数字与 . _ / - 字符，且不能以点开头', {
      code: 'git.badRef',
    });"""),
("""    return new HttpError(400, '克隆失败：该仓库需要认证。请使用公开仓库，私有仓库请改用 ZIP 上传');""",
 """    return new HttpError(
      400,
      '克隆失败：该仓库需要认证。请使用公开仓库，私有仓库请改用 ZIP 上传',
      { code: 'git.authRequired' },
    );"""),
("""  return new HttpError(400, `克隆失败：${detail}`);""",
 """  return new HttpError(400, `克隆失败：${detail}`, { code: 'git.cloneFailed', params: { reason: detail } });"""),
])

# ---------- sarif-import.ts ----------
patch('sarif-import.ts', [
("""    throw new HttpError(400, `SARIF 文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);""",
 """    throw new HttpError(
      400,
      `SARIF 文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      { code: 'sarif.invalidJson', params: { reason: error instanceof Error ? error.message : String(error) } },
    );"""),
("""    throw new HttpError(400, 'SARIF 文件顶层必须是 JSON 对象');""",
 """    throw new HttpError(400, 'SARIF 文件顶层必须是 JSON 对象', { code: 'sarif.notObject' });"""),
("""    throw new HttpError(400, `仅支持 SARIF 2.x（当前 version: ${doc.version ?? '缺失'}）`);""",
 """    throw new HttpError(400, `仅支持 SARIF 2.x（当前 version: ${doc.version ?? '缺失'}）`, {
      code: 'sarif.versionUnsupported',
      params: { version: String(doc.version ?? '缺失') },
    });"""),
("""    throw new HttpError(400, 'SARIF 文件缺少 runs 数组');""",
 """    throw new HttpError(400, 'SARIF 文件缺少 runs 数组', { code: 'sarif.runsMissing' });"""),
("""        throw new HttpError(400, `SARIF 结果数超过 ${config.maxImportEntries} 上限`);""",
 """        throw new HttpError(400, `SARIF 结果数超过 ${config.maxImportEntries} 上限`, {
          code: 'sarif.tooManyResults',
          params: { limit: config.maxImportEntries },
        });"""),
])

# ---------- scan-runner.ts（普通 Error → 扫描失败 message，落库后由前端展示） ----------
patch('scan-runner.ts', [
("""    if (!fs.existsSync(srcDir)) throw new Error('找不到扫描源码快照');
    if (plan.configFiles.length === 0) throw new Error('没有可用的规则文件');""",
 """    if (!fs.existsSync(srcDir)) throw new ScanError('scan.snapshotMissing', '找不到扫描源码快照');
    if (plan.configFiles.length === 0) throw new ScanError('scan.noRuleFiles', '没有可用的规则文件');"""),
("""      throw new Error(`扫描超过 ${Math.round(config.scanTimeoutMs / 60000)} 分钟被终止，请缩小源码范围后重试`);""",
 """      throw new ScanError(
        'scan.timedOut',
        `扫描超过 ${Math.round(config.scanTimeoutMs / 60000)} 分钟被终止，请缩小源码范围后重试`,
        { minutes: Math.round(config.scanTimeoutMs / 60000) },
      );"""),
("""      throw new Error('引擎输出超过 64MB 上限被截断，无法解析结果；请缩小源码范围或减少规则后重试');""",
 """      throw new ScanError(
        'scan.outputTruncated',
        '引擎输出超过 64MB 上限被截断，无法解析结果；请缩小源码范围或减少规则后重试',
      );"""),
("""      throw new Error(`引擎执行失败（exit=${code}）${detail ? `：${detail.slice(0, 500)}` : ''}`.trim());""",
 """      throw new ScanError(
        'scan.engineFailed',
        `引擎执行失败（exit=${code}）${detail ? `：${detail.slice(0, 500)}` : ''}`.trim(),
        { code, detail: detail ? detail.slice(0, 500) : '' },
      );"""),
], import_line="import { HttpError } from './errors.js';", import_anchor="import { config } from './config.js';")

# scan-runner 需要 ScanError 类定义（追加到 import 区之后）
s = io.open('scan-runner.ts', encoding='utf-8').read()
anchor = "import { HttpError } from './errors.js';"
assert anchor in s
s = s.replace(anchor, anchor + """

/**
 * 扫描失败错误：message 落库（scan.message，前端失败态展示），code 供前端按语言翻译。
 * message 是落库数据而非响应体，语言切换后旧记录仍为原文，属可接受折衷。
 */
export class ScanError extends Error {
  constructor(
    public code: string,
    message: string,
    public params?: Record<string, unknown>,
  ) {
    super(message);
  }
}""", 1)
io.open('scan-runner.ts', 'w', encoding='utf-8', newline='\n').write(s)

# ---------- rule-lab.ts ----------
patch('rule-lab.ts', [
("""    throw new Error('包内 rules/ 目录没有任何 YAML 规则文件');""",
 """    throw new HttpError(400, '包内 rules/ 目录没有任何 YAML 规则文件', { code: 'srv.noRulesInZip' });"""),
],
import_line="import { HttpError } from './errors.js';",
import_anchor="import { config } from './config.js';")

# ---------- pack-format.ts ----------
patch('pack-format.ts', [
("""    throw new Error(`pack.yaml 解析失败：${error instanceof Error ? error.message : String(error)}`);""",
 """    throw new HttpError(
      400,
      `pack.yaml 解析失败：${error instanceof Error ? error.message : String(error)}`,
      { code: 'pack.manifestInvalid', params: { reason: error instanceof Error ? error.message : String(error) } },
    );"""),
("""    throw new Error('pack.yaml 顶层必须是键值映射');""",
 """    throw new HttpError(400, 'pack.yaml 顶层必须是键值映射', { code: 'pack.manifestNotObject' });"""),
("""  if (!name) throw new Error('pack.yaml 缺少 name 字段');""",
 """  if (!name) throw new HttpError(400, 'pack.yaml 缺少 name 字段', { code: 'pack.nameMissing' });"""),
("""  if (name.length > 60) throw new Error('pack.yaml 的 name 不能超过 60 个字符');""",
 """  if (name.length > 60) {
    throw new HttpError(400, 'pack.yaml 的 name 不能超过 60 个字符', { code: 'pack.nameTooLong' });
  }"""),
("""  if (!version) throw new Error('pack.yaml 缺少 version 字段');""",
 """  if (!version) throw new HttpError(400, 'pack.yaml 缺少 version 字段', { code: 'pack.versionMissing' });"""),
("""  if (version.length > 30) throw new Error('pack.yaml 的 version 不能超过 30 个字符');""",
 """  if (version.length > 30) {
    throw new HttpError(400, 'pack.yaml 的 version 不能超过 30 个字符', { code: 'pack.versionTooLong' });
  }"""),
],
import_line="import { HttpError } from './errors.js';",
import_anchor="import { config } from './config.js';")
