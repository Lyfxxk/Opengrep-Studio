import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useTheme } from 'next-themes';
import { yaml as yamlLanguage } from '@codemirror/lang-yaml';
import { javascript as jsLanguage } from '@codemirror/lang-javascript';
import { python as pythonLanguage } from '@codemirror/lang-python';
import type { ViewUpdate } from '@codemirror/view';
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
import { api, translateApiError, type HealthInfo, type RuleLabMatch, type RuleLabRunResult } from '@/lib/api';
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

type ExampleMessageKey = 'lab.exampleEvalMessage' | 'lab.exampleWeakHashMessage' | 'lab.exampleTaintMessage';

function withExampleMessage(draft: LabDraft, message: string): LabDraft {
  return { ...draft, yaml: draft.yaml.replace(/(\n\s*message: ).*/, (_match, prefix: string) => `${prefix}${message}`) };
}

const LAB_EXAMPLES: Array<{
  nameKey: 'lab.exampleEval' | 'lab.exampleWeakHash' | 'lab.exampleTaint';
  messageKey: ExampleMessageKey;
  draft: LabDraft;
}> = [
  { nameKey: 'lab.exampleEval', messageKey: 'lab.exampleEvalMessage', draft: DEFAULT_DRAFT },
  {
    nameKey: 'lab.exampleWeakHash',
    messageKey: 'lab.exampleWeakHashMessage',
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
    nameKey: 'lab.exampleTaint',
    messageKey: 'lab.exampleTaintMessage',
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

function loadDraft(fallback: LabDraft = DEFAULT_DRAFT): LabDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<LabDraft>;
    return {
      yaml: typeof parsed.yaml === 'string' ? parsed.yaml : fallback.yaml,
      positive: typeof parsed.positive === 'string' ? parsed.positive : '',
      negative: typeof parsed.negative === 'string' ? parsed.negative : '',
    };
  } catch {
    return fallback;
  }
}

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

function SampleEditor({
  value,
  onChange,
  language,
}: {
  value: string;
  onChange: (value: string) => void;
  language: string;
}) {
  const { resolvedTheme } = useTheme();
  const ext = sampleLanguageExtension(language);
  const extensions = useMemo(() => {
    if (ext === 'python') return [pythonLanguage()];
    if (ext === 'javascript') return [jsLanguage({ jsx: true, typescript: language === 'typescript' || language === 'tsx' })];
    return [];
  }, [ext, language]);
  return (
    <CodeMirror
      value={value}
      onUpdate={(update: ViewUpdate) => {
        if (update.docChanged) onChange(update.state.doc.toString());
      }}
      extensions={extensions}
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      height="26vh"
      className="overflow-hidden rounded-md border text-xs [&_.cm-editor]:text-xs"
    />
  );
}

function MatchList({ matches, accent }: { matches: RuleLabMatch[]; accent: 'success' | 'warning' }) {
  const { t } = useTranslation();
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
              {match.endLine !== match.startLine
                ? t('lab.lineRangeBadge', { from: match.startLine, to: match.endLine })
                : t('lab.lineBadge', { line: match.startLine })}
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
              <h5 className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
                {t('snippet.taintFlowTitle')}
              </h5>
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
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const examples = LAB_EXAMPLES.map((item) => ({
    ...item,
    draft: withExampleMessage(item.draft, t(item.messageKey)),
  }));
  const [draft, setDraft] = useState<LabDraft>(() =>
    loadDraft(withExampleMessage(DEFAULT_DRAFT, t('lab.exampleEvalMessage'))),
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RuleLabRunResult | null>(null);
  const [saveDialog, setSaveDialog] = useState<SaveDialogState>(null);
  const [saveName, setSaveName] = useState('');
  const [saveLanguage, setSaveLanguage] = useState('JavaScript');
  const [saveSubmitting, setSaveSubmitting] = useState(false);
  const [attachSamples, setAttachSamples] = useState(true);
  const [customPacks, setCustomPacks] = useState<IRulePack[] | null>(null);
  const saveErrorRef = useRef<string>('');
  const [engineMissing, setEngineMissing] = useState<boolean | null>(null);
  const [confirmExample, setConfirmExample] = useState<LabDraft | null>(null);

  const hasSamples = Boolean(draft.positive.trim() || draft.negative.trim());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    api
      .getHealth()
      .then((health: HealthInfo) => {
        if (!cancelled) setEngineMissing(health.engineReady === false);
      })
      .catch(() => {
        if (!cancelled) setEngineMissing(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const language = useMemo(() => guessLanguage(draft.yaml), [draft.yaml]);

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
      if (res.verdict === 'fail') {
        toast.warning(
          t('lab.runFailToast', {
            reasons: res.failures
              .map((failure) => translateApiError(failure.code, failure.params, failure.message))
              .join('；'),
          }),
        );
      } else if (res.verdict === 'error') {
        toast.error(
          t('lab.runErrorToast', {
            error: translateApiError(
              res.errorCode,
              res.errorParams,
              res.error ?? t('lab.engineFailedFallback'),
            ),
          }),
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [draft, running, t]);

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

  const pickExample = (example: LabDraft) => {
    const hasContent = Boolean(draft.yaml.trim() || draft.positive.trim() || draft.negative.trim());
    const edited =
      hasContent &&
      !examples.some(
        (item) =>
          item.draft.yaml === draft.yaml &&
          item.draft.positive === draft.positive &&
          item.draft.negative === draft.negative,
      );
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

  const openSaveDialog = () => {
    const label = engineLangToPackLabel(language);
    if (label) setSaveLanguage(label);
    setSaveDialog({ mode: 'create' });
  };

  const handleSave = async () => {
    if (!saveDialog || !draft.yaml.trim()) return;
    setSaveSubmitting(true);
    saveErrorRef.current = '';
    try {
      if (saveDialog.mode === 'create') {
        const name = saveName.trim();
        if (!name) {
          saveErrorRef.current = t('rulePacks.nameRequired');
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
            ? t('lab.createdWithSamplesToast', {
                name: pack.name,
                rules: pack.ruleCount,
                samples: pack.sampleCount ?? 0,
              })
            : t('rulePacks.createdToast', { name: pack.name, count: pack.ruleCount }),
        );
        setSaveDialog(null);
      } else {
        await api.updateRulePackContent(saveDialog.pack.id, draft.yaml);
        toast.success(t('lab.overwriteSavedToast', { name: saveDialog.pack.name }));
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
          {t('lab.engineRunning')}
        </div>
      );
    }
    if (!result) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FlaskConical className="size-4" />
          {t('lab.idleHint')}
        </div>
      );
    }
    if (result.verdict === 'pass') {
      return (
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-4">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 text-sm">
            <div className="font-medium text-success">{t('rulePacks.verdictPass')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {result.positive.provided && t('lab.passPositives', { count: result.positive.matches.length })}
              {result.positive.provided && result.negative.provided && ' · '}
              {result.negative.provided && t('lab.passNegatives', { count: result.negative.matches.length })}
              {' · '}
              {t('lab.passMeta', {
                count: result.ruleIds.length,
                duration: (result.durationMs / 1000).toFixed(1),
              })}
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
            <div className="font-medium text-warning">{t('rulePacks.verdictFail')}</div>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              {result.failures.map((failure) => (
                <li key={failure.message}>
                  {translateApiError(failure.code, failure.params, failure.message)}
                </li>
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
          <div className="font-medium text-destructive">{t('lab.ruleError')}</div>
          {(result.errorCode || result.error) && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-foreground/90">
              {[
                translateApiError(result.errorCode, result.errorParams, result.error ?? ''),
                result.errorParams?.macos ? t('engine.hintMacosQuarantine') : '',
              ]
                .filter(Boolean)
                .join('\n')}
            </p>
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
                {t('lab.positiveHits', { count: result.positive.matches.length })}
              </div>
              {result.positive.matches.length > 0 ? (
                <MatchList matches={result.positive.matches} accent="success" />
              ) : (
                <p className="text-xs text-muted-foreground/70">{t('lab.positiveNoHit')}</p>
              )}
            </div>
          )}
          {result.negative.provided && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t('lab.negativeHits', { count: result.negative.matches.length })}
              </div>
              {result.negative.matches.length > 0 ? (
                <MatchList matches={result.negative.matches} accent="warning" />
              ) : (
                <p className="text-xs text-muted-foreground/70">{t('lab.negativeClean')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {engineMissing === true && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0 text-sm">
            <div className="font-medium text-warning">{t('lab.engineMissingTitle')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('lab.engineMissingHint')}</p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {language && (
          <Badge variant="outline" className="font-normal">
            {t('lab.langBadge', { language })}
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
                {t('lab.saveToPack')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => openSaveDialog()}>
                {t('lab.saveAsNew')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('lab.overwriteLabel')}</DropdownMenuLabel>
              {customPacks === null ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('common.loading')}</div>
              ) : customPacks.filter((pack) => !pack.isDir).length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('lab.noOverwriteCandidates')}
                </div>
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
                        {t('lab.packRulesShort', { count: pack.ruleCount })}
                      </span>
                    </DropdownMenuItem>
                  ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            className="gap-1"
            disabled={running || !canRun}
            onClick={() => void run()}
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? t('lab.runningBtn') : t('lab.runBtn')}
          </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('lab.yamlTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeMirror
              value={draft.yaml}
              onUpdate={(update: ViewUpdate) => {
                if (update.docChanged) setDraft((prev) => ({ ...prev, yaml: update.state.doc.toString() }));
              }}
              extensions={[yamlLanguage()]}
              theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
              height="46vh"
              className="overflow-hidden rounded-md border text-xs [&_.cm-editor]:text-xs"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base">{t('lab.samplesTitle')}</CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
                  {t('lab.loadExample')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {examples.map((example) => (
                  <DropdownMenuItem
                    key={example.nameKey}
                    onSelect={() => pickExample(example.draft)}
                  >
                    {t(example.nameKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="positive">
              <TabsList className="mb-2">
                <TabsTrigger value="positive">{t('lab.tabPositive')}</TabsTrigger>
                <TabsTrigger value="negative">{t('lab.tabNegative')}</TabsTrigger>
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
            <CardTitle className="text-base">{t('lab.resultTitle')}</CardTitle>
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
                ? t('lab.saveDialogTitleOverwrite', { name: saveDialog.pack.name })
                : t('lab.saveDialogTitleCreate')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {saveDialog?.mode === 'create' ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="lab-save-name">{t('rulePacks.uploadNameLabel')}</Label>
                    <Input
                      id="lab-save-name"
                      value={saveName}
                      maxLength={50}
                      placeholder={t('lab.saveNamePlaceholder')}
                      onChange={(event) => setSaveName(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('rulePacks.uploadLangLabel')}</Label>
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
                    <span className="font-medium">{t('lab.attachSamplesTitle')}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {hasSamples ? t('lab.attachSamplesOn') : t('lab.attachSamplesOff')}
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('lab.overwriteWarning')}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              className="gap-1"
              disabled={saveSubmitting}
              onClick={() => void handleSave()}
            >
              {saveSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {saveSubmitting ? t('rulePacks.saving') : t('lab.confirmSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmExample !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmExample(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('lab.confirmExampleTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('lab.confirmExampleDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmExample) applyExample(confirmExample);
              }}
            >
              {t('lab.confirmContinue')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
