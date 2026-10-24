/**
 * taint 规则命中的 dataflow_trace 提取（引擎需带 --dataflow-traces 参数）。
 * 实测结构（opengrep v1.31.0）：
 *   { taint_source: ["CliLoc", [{path,start,end}, "req.query"]],
 *     intermediate_vars: [{location: {path,start,end}, content: "code"}, ...],
 *     taint_sink: ["CliLoc", [{path,start,end}, "eval(middle)"]] }
 * 解析必须防御式：字段缺失/形态不符时返回 undefined，绝不抛错影响主流程。
 */

export interface TaintStep {
  /** source | intermediate | sink */
  role: 'source' | 'intermediate' | 'sink';
  /** 相对源码根的文件路径（由调用方做 relativize） */
  path: string;
  line: number;
  col?: number;
  /** 该步的代码文本（变量名 / 表达式），截断到 120 字符 */
  text?: string;
}

const MAX_STEPS = 24;
const MAX_TEXT = 120;

interface EngineLocation {
  path?: unknown;
  start?: { line?: unknown; col?: unknown } | null;
}

function parseLocation(loc: unknown): { path: string; line: number; col?: number } | undefined {
  if (typeof loc !== 'object' || loc === null) return undefined;
  const { path, start } = loc as EngineLocation;
  if (typeof path !== 'string' || path === '') return undefined;
  const line = typeof (start as { line?: unknown } | null | undefined)?.line === 'number'
    ? (start as { line: number }).line
    : undefined;
  if (line === undefined || !Number.isFinite(line)) return undefined;
  const col = typeof (start as { col?: unknown } | null | undefined)?.col === 'number'
    ? (start as { col: number }).col
    : undefined;
  return { path, line, col };
}

function parseEndpoint(endpoint: unknown): { loc: { path: string; line: number; col?: number }; text?: string } | undefined {
  // 端点形态为 [tag, [location, text?]]，tag 无业务含义（"CliLoc"）
  if (!Array.isArray(endpoint) || endpoint.length < 2 || !Array.isArray(endpoint[1])) {
    return undefined;
  }
  const loc = parseLocation(endpoint[1][0]);
  if (!loc) return undefined;
  const text = typeof endpoint[1][1] === 'string' ? endpoint[1][1].slice(0, MAX_TEXT) : undefined;
  return { loc, text };
}

function toStep(
  role: TaintStep['role'],
  loc: { path: string; line: number; col?: number },
  text?: string,
): TaintStep {
  return { role, path: loc.path, line: loc.line, ...(loc.col !== undefined ? { col: loc.col } : {}), ...(text ? { text } : {}) };
}

/** 提取污点传播链（source → intermediates → sink），路径由调用方 relativize */
export function extractTaintFlow(raw: unknown): TaintStep[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const trace = raw as {
    taint_source?: unknown;
    intermediate_vars?: unknown;
    taint_sink?: unknown;
  };
  const steps: TaintStep[] = [];

  const source = parseEndpoint(trace.taint_source);
  if (source) steps.push(toStep('source', source.loc, source.text));

  if (Array.isArray(trace.intermediate_vars)) {
    for (const item of trace.intermediate_vars) {
      if (typeof item !== 'object' || item === null) continue;
      const { location, content } = item as { location?: unknown; content?: unknown };
      const loc = parseLocation(location);
      if (!loc) continue;
      steps.push(toStep('intermediate', loc, typeof content === 'string' ? content : undefined));
    }
  }

  const sink = parseEndpoint(trace.taint_sink);
  if (sink) steps.push(toStep('sink', sink.loc, sink.text));

  if (steps.length === 0) return undefined;
  return steps.slice(0, MAX_STEPS);
}

/** 把提取出的链路路径 relativize 到源码根，并限制总大小（防超长链撑爆存储） */
export function relativizeTaintFlow(
  steps: TaintStep[] | undefined,
  relativize: (path: string) => string,
): TaintStep[] | undefined {
  if (!steps) return undefined;
  const mapped = steps.slice(0, MAX_STEPS).map((step) => ({
    ...step,
    path: relativize(step.path),
    ...(step.text ? { text: step.text.slice(0, MAX_TEXT) } : {}),
  }));
  return mapped;
}
