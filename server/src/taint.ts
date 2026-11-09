
export interface TaintStep {
  role: 'source' | 'intermediate' | 'sink';
  path: string;
  line: number;
  col?: number;
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
  if (steps.length <= MAX_STEPS) return steps;
  return [...steps.slice(0, MAX_STEPS - 1), steps[steps.length - 1]];
}

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
