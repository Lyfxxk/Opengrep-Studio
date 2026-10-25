import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  Save,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { javascript as jsLanguage } from '@codemirror/lang-javascript';
import { python as pythonLanguage } from '@codemirror/lang-python';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PACK_LANGUAGES } from '@/data/constants';
import type { IRulePack } from '@/data/rulepacks';
import { api, type HealthInfo, type RuleLabMatch, type RuleLabRunResult } from '@/lib/api';
import TaintFlow from '@/pages/ScanResult/TaintFlow';

const DRAFT_KEY = 'rulelab-draft-v1';

interface LabDraft {
  yaml: string;
  positive: string;
  negative: string;
}

const DEFAULT_DRAFT: LabDraft = {
  yaml: `rules:
  - id: js-dangerous-eval
    languages: [javascript]
    message: 使用 eval 动态执行代码，存在代码注入风险
    severity: WARNING
    pattern: eval(...)
`,
  positive: `function runUserCode(input) {
  return eval(input);
}
`,
  negative: `function safeRun(a, b) {
  return new Function('return ' + (a + b))();
}
`,
};

/** 内置示例：覆盖 pattern 与 taint 两种写法，方便新手上手 */
const LAB_EXAMPLES: Array<{ name: string; draft: LabDraft }> = [
  { name: 'JS：eval 检测', draft: DEFAULT_DRAFT },
  {
    name: 'Python：弱哈希 MD5',
    draft: {
      yaml: `rules:
  - id: py-weak-hash-md5
    languages: [python]
    message: 使用弱哈希算法 MD5
    severity: ERROR
    metadata:
      security-severity: "7.5"
    patterns:
      - pattern: hashlib.md5(...)
`,
      positive: `import hashlib

def digest(token):
    return hashlib.md5(token.encode()).hexdigest()
`,
      negative: `import hashlib

def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()
`,
    },
  },
  {
    name: 'JS：Taint 污点分析',
    draft: {
      yaml: `rules:
  - id: js-taint-eval
    languages: [javascript]
    message: 不可信输入进入 eval 执行
    severity: ERROR
    mode: taint
    pattern-sources:
      - pattern: req.query
    pattern-sinks:
      - pattern: eval(...)
`,
      positive: `function handle(req) {
  eval(req.query.code);
}
`,
      negative: `function handle() {
  eval("1 + 1");
}
`,
    },
  },
];

function loadDraft(): LabDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return DEFAULT_DRAFT;
    const parsed = JSON.parse(raw) as Partial<LabDraft>;
    return {
      yaml: typeof parsed.yaml === 'string' ? parsed.yaml : DEFAULT_DRAFT.yaml,
      positive: typeof parsed.positive === 'string' ? parsed.positive : '',
      negative: typeof parsed.negative === 'string' ? parsed.negative : '',
    };
  } catch {
    return DEFAULT_DRAFT;
  }
}

/** 从规则 YAML 粗提取第一条规则的语言（仅用于展示，真实推断以后端为准） */
function guessLanguage(yamlText: string): string {
  const match = yamlText.match(/languages:\s*\[([^\]]+)\]/);
  if (match) return match[1].split(',')[0].trim();
  const single = yamlText.match(/languages:\s*(\S+)/);
  return single ? single[1].trim() : '';
}

function sampleLanguageExtension(language: string): 'javascript' | 'python' | 'none' {
  if (language.startsWith('python')) return 'python';
  if (['javascript', 'typescript', 'jsx', 'tsx'].includes(language)) return 'javascript';
  return 'none';
}

/** 代码样本编辑器：按规则语言挂语法高亮 */
function SampleEditor({
  value,
  onChange,
  language,
}: {
  value: string;
  onChange: (value: string) => void;
  language: string;
}) {
  const ext = sampleLanguageExtension(language);
  const extensions = useMemo(() => {
    if (ext === 'python') return [pythonLanguage()];
    if (ext === 'javascript') return [jsLanguage({ jsx: true, typescript: language === 'typescript' || language === 'tsx' })];
    return [];
  }, [ext, language]);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      height="26vh"
      className="overflow-hidden rounded-md border text-xs [&_.cm-editor]:text-xs"
    />
  );
}

function MatchList({ matches, accent }: { matches: RuleLabMatch[]; accent: 'success' | 'warning' }) {
  if (matches.length === 0) return null;
  return (
    <ul className="space-y-2">
      {matches.map((match, index) => (
        <li
          key={`${match.checkId}-${match.startLine}-${index}`}
          className={`rounded-md border-l-4 bg-muted/40 px-3 py-2 ${
            accent === 'success' ? 'border-success' : 'border-warning'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="font-normal">
              第 {match.startLine}
              {match.endLine !== match.startLine ? `–${match.endLine}` : ''} 行
            </Badge>
            <span className="text-muted-foreground">{match.ruleId}</span>
            <span className="text-muted-foreground/70">·</span>
            <span className="text-muted-foreground">{match.severity}</span>
          </div>
          {match.matchedLines && (
            <pre className="mt-2 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/90">
              {match.matchedLines.replace(/\n$/, '')}
            </pre>
          )}
          {match.taintFlow && match.taintFlow.length > 0 && (
            <div className="mt-2 border-t border-border/60 pt-2">
              <h5 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">污点传播链</h5>
              <TaintFlow steps={match.taintFlow} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}


type SaveDialogState =
  | { mode: 'create' }
  | { mode: 'overwrite'; pack: IRulePack }
  | null;

/** 引擎语言（snake_case）→ 规则包语言标签（PACK_LANGUAGES），无法映射时返回 undefined */
function engineLangToPackLabel(engineLang: string): string | undefined {
  const map: Record<string, string> = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    jsx: 'JavaScript',
    tsx: 'TypeScript',
    python: 'Python',
    python2: 'Python',
    python3: 'Python',
    java: 'Java',
    go: 'Go',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    php: 'PHP',
    ruby: 'Ruby',
    rust: 'Rust',
    kotlin: 'Kotlin',
    swift: 'Swift',
    dockerfile: 'Dockerfile',
  };
  return map[engineLang.toLowerCase()];
}

export default function LabPage() {
  const [draft, setDraft] = useState<LabDraft>(loadDraft);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RuleLabRunResult | null>(null);
  const [saveDialog, setSaveDialog] = useState<SaveDialogState>(null);
  const [saveName, setSaveName] = useState('');
  const [saveLanguage, setSaveLanguage] = useState('JavaScript');
  const [saveSubmitting, setSaveSubmitting] = useState(false);
  const [attachSamples, setAttachSamples] = useState(true);
  const [customPacks, setCustomPacks] = useState<IRulePack[] | null>(null);
  const saveErrorRef = useRef<string>('');
  // P5：引擎预检（null=检测中，true=缺失）
  const [engineMissing, setEngineMissing] = useState<boolean | null>(null);
  // P4：载入示例前若会覆盖已编辑内容，先确认
  const [confirmExample, setConfirmExample] = useState<LabDraft | null>(null);

  // 保存时是否把当前正/反例样本写进规则包（可移植目录包，之后可在规则包页一键质量检查）
  const hasSamples = Boolean(draft.positive.trim() || draft.negative.trim());

  // 草稿自动保存（防抖 400ms）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft]);

  // P5：进入实验室时预检引擎可用性，缺失则提前提示而不是等运行失败
  useEffect(() => {
    let cancelled = false;
    api
      .getHealth()
      .then((health: HealthInfo) => {
        if (!cancelled) setEngineMissing(health.engine === 'MISSING');
      })
      .catch(() => {
        if (!cancelled) setEngineMissing(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const language = useMemo(() => guessLanguage(draft.yaml), [draft.yaml]);

  // P3：正反例全空时不允许运行（后端同样校验，这里是即时反馈）
  const canRun = Boolean(draft.yaml.trim()) && hasSamples && engineMissing !== true;

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      const res = await api.ruleLabRun({
        yaml: draft.yaml,
        positive: draft.positive,
        negative: draft.negative,
      });
      setResult(res);
      if (res.verdict === 'pass') {
        toast.success(`实验通过：正例命中 ${res.positive.matches.length} 处，反例无误报`);
      } else if (res.verdict === 'fail') {
        toast.warning(`实验未通过：${res.failReasons.join('；')}`);
      } else {
        toast.error(`实验出错：${res.error ?? '引擎执行失败'}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [draft, running]);

  // Ctrl/Cmd + Enter 运行
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (canRun) void run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run, canRun]);

  const loadPacks = useCallback(() => {
    api
      .listRulePacks()
      .then((packs) => setCustomPacks(packs.filter((pack) => !pack.builtin)))
      .catch(() => setCustomPacks([]));
  }, []);

  // P4：示例会不会覆盖用户已编辑的内容？当前 YAML 与所有内置示例都不同且非空 → 视为有编辑，需要确认
  const pickExample = (example: LabDraft) => {
    const edited =
      draft.yaml.trim() !== '' &&
      !LAB_EXAMPLES.some((item) => item.draft.yaml === draft.yaml);
    if (edited) {
      setConfirmExample(example);
    } else {
      applyExample(example);
    }
  };

  const applyExample = (example: LabDraft) => {
    setDraft(example);
    setResult(null);
    setConfirmExample(null);
  };

  // P6：打开"另存为新规则包"时，语言标签默认从引擎语言推导
  const openSaveDialog = (mode: 'create') => {
    const label = engineLangToPackLabel(language);
    if (label) setSaveLanguage(label);
    setSaveDialog({ mode });
  };

  const handleSave = async () => {
    if (!saveDialog || !draft.yaml.trim()) return;
    setSaveSubmitting(true);
    saveErrorRef.current = '';
    try {
      if (saveDialog.mode === 'create') {
        const name = saveName.trim();
        if (!name) {
          saveErrorRef.current = '请输入规则包名称';
          return;
        }
        const pack = await api.createRulePack(
          name,
          saveLanguage,
          draft.yaml,
          attachSamples && hasSamples
            ? { positive: draft.positive, negative: draft.negative }
            : undefined,
        );
        toast.success(
          attachSamples && hasSamples
            ? `规则包「${pack.name}」已创建（${pack.ruleCount} 条规则、${pack.sampleCount ?? 0} 个样本）`
            : `规则包「${pack.name}」已创建，解析到 ${pack.ruleCount} 条规则`,
        );
        setSaveDialog(null);
      } else {
        await api.updateRulePackContent(saveDialog.pack.id, draft.yaml);
        toast.success(`已覆盖保存到规则包「${saveDialog.pack.name}」`);
        setSaveDialog(null);
      }
    } catch (error) {
      saveErrorRef.current = error instanceof Error ? error.message : String(error);
    } finally {
      setSaveSubmitting(false);
      if (saveErrorRef.current) {
        toast.error(saveErrorRef.current);
        saveErrorRef.current = '';
      }
    }
  };

  const verdictView = () => {
    if (running) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          引擎运行中，正在对样本做匹配…
        </div>
      );
    }
    if (!result) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FlaskConical className="size-4" />
          点击「运行实验」或按 Ctrl+Enter，查看规则能否正确命中
        </div>
      );
    }
    if (result.verdict === 'pass') {
      return (
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 text-sm">
            <div className="font-medium text-success">通过</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {result.positive.provided && `正例命中 ${result.positive.matches.length} 处`}
              {result.positive.provided && result.negative.provided && ' · '}
              {result.negative.provided && `反例 ${result.negative.matches.length} 处误报`}
              {' · '}规则 {result.ruleIds.length} 条 · 引擎耗时 {(result.durationMs / 1000).toFixed(1)}s
            </div>
          </div>
        </div>
      );
    }
    if (result.verdict === 'fail') {
      return (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0 text-sm">
            <div className="font-medium text-warning">未通过</div>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              {result.failReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
        <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="min-w-0 text-sm">
          <div className="font-medium text-destructive">规则错误</div>
          {result.error && (
            <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-foreground/90">{result.error}</p>
          )}
          {result.engineErrors.map((message) => (
            <p key={message} className="mt-1 whitespace-pre-wrap font-mono text-xs text-foreground/90">
              {message}
            </p>
          ))}
        </div>
      </div>
    );
  };

  const resultBody = () => (
    <div className="space-y-4">
      {verdictView()}
      {result && result.verdict !== 'error' && (
        <div className="space-y-4">
          {result.positive.provided && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                正例命中（{result.positive.matches.length} 处）
              </div>
              {result.positive.matches.length > 0 ? (
                <MatchList matches={result.positive.matches} accent="success" />
              ) : (
                <p className="text-xs text-muted-foreground/70">没有命中，检查 pattern 是否写对</p>
              )}
            </div>
          )}
          {result.negative.provided && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                反例命中（{result.negative.matches.length} 处）
              </div>
              {result.negative.matches.length > 0 ? (
                <MatchList matches={result.negative.matches} accent="warning" />
              ) : (
                <p className="text-xs text-muted-foreground/70">无误报</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* P5：引擎缺失时提前拦截，避免白等一次失败 */}
      {engineMissing === true && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0 text-sm">
            <div className="font-medium text-warning">扫描引擎未就绪</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              未找到 opengrep 引擎，无法运行实验。请在仓库根目录执行 npm run setup:engine 安装后刷新页面。
            </p>
          </div>
        </div>
      )}
      {/* 页头由规则中心（RulesCenterPage）统一提供，这里只保留工具条 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {language && (
          <Badge variant="outline" className="font-normal">
            语言：{language}
          </Badge>
        )}
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) loadPacks();
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-1" disabled={!draft.yaml.trim()}>
                <Save className="size-4" />
                保存到规则包
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => openSaveDialog('create')}>
                另存为新规则包…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>覆盖到已有规则包</DropdownMenuLabel>
              {customPacks === null ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">加载中…</div>
              ) : customPacks.filter((pack) => !pack.isDir).length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无可覆盖的单文件规则包</div>
              ) : (
                customPacks
                  .filter((pack) => !pack.isDir)
                  .map((pack) => (
                    <DropdownMenuItem
                      key={pack.id}
                      onSelect={() => setSaveDialog({ mode: 'overwrite', pack })}
                    >
                      <span className="truncate">{pack.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {pack.ruleCount} 条
                      </span>
                    </DropdownMenuItem>
                  ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            className="gap-1"
            disabled={running || !canRun}
            title={canRun ? undefined : '请填写规则 YAML 和至少一个测试样本'}
            onClick={() => void run()}
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? '运行中…' : '运行实验'}
          </Button>
      </div>

      {/* P2：宽屏三栏并排（YAML | 样本 | 结果），编辑与查看不滚动切换；窄屏降级为现有上下布局 */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">规则 YAML</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeMirror
              value={draft.yaml}
              onChange={(value) => setDraft((prev) => ({ ...prev, yaml: value }))}
              extensions={[yamlLanguage()]}
              height="46vh"
              className="overflow-hidden rounded-md border text-xs [&_.cm-editor]:text-xs"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base">测试样本</CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
                  载入示例
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {LAB_EXAMPLES.map((example) => (
                  <DropdownMenuItem
                    key={example.name}
                    onSelect={() => pickExample(example.draft)}
                  >
                    {example.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="positive">
              <TabsList className="mb-2">
                <TabsTrigger value="positive">正例（期望命中）</TabsTrigger>
                <TabsTrigger value="negative">反例（期望无误报）</TabsTrigger>
              </TabsList>
              <TabsContent value="positive">
                <SampleEditor
                  value={draft.positive}
                  onChange={(value) => setDraft((prev) => ({ ...prev, positive: value }))}
                  language={language}
                />
              </TabsContent>
              <TabsContent value="negative">
                <SampleEditor
                  value={draft.negative}
                  onChange={(value) => setDraft((prev) => ({ ...prev, negative: value }))}
                  language={language}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 xl:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">实验结果</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[52vh] overflow-y-auto">
            {resultBody()}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={saveDialog !== null}
        onOpenChange={(open) => {
          if (!open) setSaveDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {saveDialog?.mode === 'overwrite'
                ? `覆盖规则包「${saveDialog.pack.name}」`
                : '另存为新规则包'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {saveDialog?.mode === 'create' ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="lab-save-name">规则包名称</Label>
                    <Input
                      id="lab-save-name"
                      value={saveName}
                      maxLength={50}
                      placeholder="例如：实验规则包"
                      onChange={(event) => setSaveName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>适用语言</Label>
                    <Select value={saveLanguage} onValueChange={setSaveLanguage}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PACK_LANGUAGES.map((item) => (
                          <SelectItem key={item} value={item}>
                            {item}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <label className="flex items-start gap-2.5 rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={attachSamples && hasSamples}
                    disabled={!hasSamples}
                    onCheckedChange={(checked) => setAttachSamples(checked === true)}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">附带测试样本</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {hasSamples
                        ? '正/反例随包保存为可移植规则包，之后可在规则包页一键质量检查回归'
                        : '当前没有填写测试样本，将创建普通单文件规则包'}
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                将用当前编辑器中的 YAML 替换该规则包的全部内容，且不可撤销。内置规则包不可覆盖。
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialog(null)}>
              取消
            </Button>
            <Button
              className="gap-1"
              disabled={saveSubmitting}
              onClick={() => void handleSave()}
            >
              {saveSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {saveSubmitting ? '保存中…' : '确认保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* P4：示例会覆盖已编辑内容时二次确认 */}
      <AlertDialog
        open={confirmExample !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmExample(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>载入示例将覆盖当前内容</AlertDialogTitle>
            <AlertDialogDescription>
              当前规则 YAML 与所有内置示例都不同，载入示例会替换规则和测试样本，且不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmExample) applyExample(confirmExample);
              }}
            >
              继续载入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}