import { config } from './config.js';
import { HttpError } from './errors.js';
import type { IssueRow, Severity } from './db.js';

/**
 * SARIF 导入：把外部工具（Semgrep / CodeQL / 其他 Studio 实例…）的 SARIF 结果
 * 引入为一个"已完成"的扫描记录，统一参与结果页、报告与基线对比。
 *
 * 映射口径（与自研导出 server/src/sarif.ts 互为逆操作，保证往返无损）：
 * - severity：优先读 Studio 导出时写入的 result.properties.severity（critical/high/medium/low），
 *   否则按 SARIF level 映射 error→high、warning→medium、note/none→low；
 * - fingerprint：优先 partialFingerprints['opengrepFingerprint/v1']（导出时写入），
 *   否则合成 `ruleId:path:line`——与引擎扫描的兜底口径一致，跨工具也能做基线 diff；
 * - 仅接受 2.x 版本与 runs 数组；多 run 合并、按 fingerprint 去重；空 results 合法
 *   （导入一份"0 问题"的 SARIF 作为干净基线是真实工作流）。
 */

interface SarifRegion {
  startLine?: number;
  endLine?: number;
}

interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string; uriBaseId?: string };
  region?: SarifRegion;
}

interface SarifMessage {
  text?: string;
  markdown?: string;
}

interface SarifRule {
  id?: string;
  shortDescription?: SarifMessage;
  fullDescription?: SarifMessage;
}

interface SarifResult {
  ruleId?: string;
  ruleIndex?: number;
  level?: string;
  message?: SarifMessage;
  locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>;
  partialFingerprints?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

interface SarifRun {
  tool?: {
    driver?: { name?: string; rules?: SarifRule[] };
  };
  results?: SarifResult[];
}

interface SarifLog {
  version?: string;
  runs?: SarifRun[];
}

export interface SarifImportResult {
  /** 首个 run 的 tool.driver.name（无则"未知工具"），用于扫描记录的来源标注 */
  toolName: string;
  /** 映射后的 issues（id 为空串、comparisonStatus 固定 remaining，由调用方做基线对比） */
  issues: IssueRow[];
}

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);

/** SARIF level → Studio 严重度（仅在没有 Studio 导出的 properties.severity 时使用） */
function severityFromLevel(level: string | undefined): Severity {
  switch (level) {
    case 'error': return 'high';
    case 'warning': return 'medium';
    default: return 'low';
  }
}

function severityOf(result: SarifResult): Severity {
  const tagged = result.properties?.severity;
  if (typeof tagged === 'string' && SEVERITIES.has(tagged)) {
    return tagged as Severity;
  }
  return severityFromLevel(result.level);
}

/** artifactLocation.uri → 工作台内的相对路径展示口径 */
function normalizeUri(raw: string): string {
  let uri = raw.trim();
  if (/^file:\/\//i.test(uri)) {
    uri = uri.replace(/^file:\/\//i, '');
    try {
      uri = decodeURIComponent(uri);
    } catch {
    }
  }
  uri = uri.replace(/\\/g, '/').replace(/^\.\//, '');
  // file:///D:/... 解码后带伪根斜杠（Windows 盘符 URI），剥离
  return uri.replace(/^\/(?=[A-Za-z]:\/)/, '');
}

function linesOf(region: SarifRegion | undefined): { startLine: number; endLine: number } {
  const start = Number(region?.startLine ?? 0);
  const startLine = Number.isInteger(start) && start >= 1 ? start : 1;
  const end = Number(region?.endLine ?? 0);
  const endLine = Number.isInteger(end) && end >= startLine ? end : startLine;
  return { startLine, endLine };
}

function fingerprintOf(result: SarifResult, ruleId: string, uri: string, startLine: number): string {
  const fps = result.partialFingerprints;
  if (fps && typeof fps === 'object' && !Array.isArray(fps)) {
    const preferred = fps['opengrepFingerprint/v1'] ?? Object.values(fps)[0];
    const value =
      typeof preferred === 'string'
        ? preferred
        : preferred && typeof preferred === 'object'
          ? String(Object.values(preferred as Record<string, unknown>)[0] ?? '')
          : '';
    if (value) return value;
  }
  // 与 scan-runner 的引擎兜底同口径：跨工具、跨扫描均可参与基线 diff
  return `${ruleId}:${uri}:${startLine}`;
}

function messageOf(result: SarifResult, rule: SarifRule | undefined): string {
  const text = result.message?.text?.trim() || result.message?.markdown?.trim();
  if (text) return text;
  const fromRule = rule?.shortDescription?.text?.trim() || rule?.fullDescription?.text?.trim();
  return fromRule || '（SARIF 结果未提供描述）';
}

/** 解析 SARIF 文本并映射为 issues；结构不合法抛 HttpError(400) */
export function parseSarifImport(text: string): SarifImportResult {
  let doc: SarifLog;
  try {
    doc = JSON.parse(text) as SarifLog;
  } catch (error) {
    throw new HttpError(400, `SARIF 文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new HttpError(400, 'SARIF 文件顶层必须是 JSON 对象');
  }
  if (typeof doc.version !== 'string' || !doc.version.startsWith('2.')) {
    throw new HttpError(400, `仅支持 SARIF 2.x（当前 version: ${doc.version ?? '缺失'}）`);
  }
  if (!Array.isArray(doc.runs)) {
    throw new HttpError(400, 'SARIF 文件缺少 runs 数组');
  }

  const issues: IssueRow[] = [];
  const seenFingerprints = new Set<string>();
  let toolName = '';
  let totalResults = 0;

  for (const run of doc.runs) {
    const driver = run?.tool?.driver;
    const rules = Array.isArray(driver?.rules) ? driver!.rules! : [];
    if (!toolName && typeof driver?.name === 'string' && driver.name.trim()) {
      toolName = driver.name.trim();
    }
    for (const result of run?.results ?? []) {
      totalResults += 1;
      if (totalResults > config.maxImportEntries) {
        throw new HttpError(400, `SARIF 结果数超过 ${config.maxImportEntries} 上限`);
      }
      const rule =
        (typeof result.ruleIndex === 'number' ? rules[result.ruleIndex] : undefined) ?? undefined;
      const ruleId = (result.ruleId ?? rule?.id ?? '').trim();
      if (!ruleId) continue;

      const physical = result.locations?.[0]?.physicalLocation;
      const uri = normalizeUri(physical?.artifactLocation?.uri ?? '');
      const { startLine, endLine } = linesOf(physical?.region);
      const fingerprint = fingerprintOf(result, ruleId, uri, startLine);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);

      issues.push({
        id: '',
        scanId: '',
        fingerprint,
        ruleId,
        severity: severityOf(result),
        comparisonStatus: 'remaining',
        message: messageOf(result, rule),
        filePath: uri || '（未知路径）',
        startLine,
        endLine,
        matchedLines: undefined,
        rulepackId: undefined,
        rulepackName: undefined,
      });
    }
  }

  return { toolName: toolName || '未知工具', issues };
}
