import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  BookOpen,
  ExternalLink,
  FlaskConical,
  GraduationCap,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { IKnowledgeSample, IRuleKnowledge } from '@/data/diffs';
import { type IIssue } from '@/data/issues';
import { api } from '@/lib/api';

interface KnowledgeSheetProps {
  ruleId: string | null;
  onClose: () => void;
}

function SampleBlock({ title, samples }: { title: string; samples: IKnowledgeSample[] }) {
  if (!samples || samples.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">{title}</h4>
      <div className="space-y-2">
        {samples.map((sample) => (
          <pre
            key={sample.name}
            className="overflow-x-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] leading-5"
          >
            {sample.content}
          </pre>
        ))}
      </div>
    </div>
  );
}

/** 规则知识抽屉：中文说明 + CWE/OWASP 中文解释 + 修复建议 + 命中统计 + 上游溯源 + 样本 */
export default function KnowledgeSheet({ ruleId, onClose }: KnowledgeSheetProps) {
  const { t, i18n } = useTranslation();
  const [knowledge, setKnowledge] = useState<IRuleKnowledge | null>(null);
  const [loading, setLoading] = useState(false);
  // 知识库只有简繁两份：繁体走 zh-Hant，其余统一用简体
  const lang = (i18n.resolvedLanguage ?? i18n.language).startsWith('zh-Hant') ? 'zh-Hant' : 'zh';

  useEffect(() => {
    if (!ruleId) {
      setKnowledge(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    api
      .getRuleKnowledge(ruleId, lang)
      .then((data) => {
        if (mounted) setKnowledge(data);
      })
      .catch((error) => {
        if (mounted) {
          setKnowledge(null);
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [ruleId, lang]);

  return (
    <Sheet open={ruleId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4 text-primary" />
            {t('knowledge.title', { ruleId })}
          </SheetTitle>
          <SheetDescription>{t('knowledge.subtitle')}</SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('knowledge.loading')}
          </div>
        ) : !knowledge ? (
          <p className="text-sm text-muted-foreground">{t('knowledge.empty')}</p>
        ) : (
          <div className="space-y-5 pr-1">
            {knowledge.zhMessage ? (
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <GraduationCap className="size-3.5" />
                  {t('knowledge.zhMessageTitle')}
                </h4>
                <p className="rounded-lg border bg-muted/40 p-3 text-sm leading-6">{knowledge.zhMessage}</p>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                {t('knowledge.zhMessageMissing')}
              </p>
            )}

            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('knowledge.metadataTitle')}</h4>
              <div className="flex flex-wrap gap-1.5">
                {knowledge.severity && (
                  <Badge variant="outline" className="font-normal">
                    {t('knowledge.engineSeverity', { severity: knowledge.severity })}
                  </Badge>
                )}
                {knowledge.securitySeverity !== undefined && (
                  <Badge variant="outline" className="font-normal">
                    security-severity：{knowledge.securitySeverity}
                  </Badge>
                )}
                {knowledge.pack && (
                  <Badge variant="secondary" className="font-normal">
                    {t('knowledge.packSource', { name: knowledge.pack.name })}
                    {knowledge.pack.builtin ? t('knowledge.packBuiltinSuffix') : ''}
                  </Badge>
                )}
                {knowledge.owasp.map((item) => (
                  <Badge key={item} variant="outline" className="font-normal">
                    OWASP {item}
                  </Badge>
                ))}
              </div>
            </div>

            {knowledge.cwe.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('knowledge.cweTitle')}</h4>
                <div className="space-y-2">
                  {knowledge.cwe.map((item) => (
                    <div key={item.id} className="rounded-lg border p-2.5 text-xs">
                      <span className="font-mono text-muted-foreground">{item.id}</span>
                      {item.name && <span className="ml-2 font-medium">{item.name}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {knowledge.fixSuggestion && (
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ShieldCheck className="size-3.5" />
                  {t('knowledge.fixTitle')}
                </h4>
                <p className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm leading-6">
                  {knowledge.fixSuggestion}
                </p>
              </div>
            )}

            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">{t('knowledge.statsTitle')}</h4>
              <p className="text-sm">
                {t('knowledge.statsBody', { total: knowledge.stats.total, projects: knowledge.stats.projects })}
                {knowledge.stats.lastSeen && (
                  <span className="text-xs text-muted-foreground">
                    {t('knowledge.statsLastSeen', { date: knowledge.stats.lastSeen.slice(0, 10) })}
                  </span>
                )}
              </p>
            </div>

            {knowledge.samples && (
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <FlaskConical className="size-3.5" />
                  {t('knowledge.samplesTitle')}
                </h4>
                <div className="space-y-3">
                  <SampleBlock title={t('knowledge.samplePositives')} samples={knowledge.samples.positives} />
                  <SampleBlock title={t('knowledge.sampleNegatives')} samples={knowledge.samples.negatives} />
                </div>
              </div>
            )}

            {knowledge.upstreamUrl && (
              <a
                href={knowledge.upstreamUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3.5" />
                {t('knowledge.upstreamLink')}
              </a>
            )}

            {!knowledge.found && (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                {t('knowledge.notFound')}
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * 供列表/详情处复用的知识库入口。用 span[role=button] 而非 button：
 * 它嵌在问题卡片（外层 button）内部，HTML 不允许按钮嵌套；
 * 键盘可达性由 tabIndex + onKeyDown 补齐。
 */
export function KnowledgeLink({ issue, onOpen }: { issue: IIssue; onOpen: (ruleId: string) => void }) {
  const { t } = useTranslation();
  return (
    // min-w-0 + truncate：规则 ID 可能很长，卡片窄时收缩省略，防止把问题列表撑出横向滚动
    <span
      role="button"
      tabIndex={0}
      title={t('knowledge.linkTitle')}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(issue.ruleId);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(issue.ruleId);
      }}
      className="min-w-0 cursor-pointer truncate font-mono text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {issue.ruleId}
    </span>
  );
}
