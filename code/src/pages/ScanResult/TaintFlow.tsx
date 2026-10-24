import { ArrowDown, Crosshair, Waypoints, Zap } from 'lucide-react';
import { TAINT_ROLE_LABELS, type ITaintStep } from '@/data/issues';
import { cn } from '@/lib/utils';

const ROLE_STYLES: Record<ITaintStep['role'], { icon: typeof Zap; badgeClass: string }> = {
  source: { icon: Crosshair, badgeClass: 'bg-warning/10 text-warning border-warning/30' },
  intermediate: { icon: Waypoints, badgeClass: 'bg-primary/10 text-primary border-primary/30' },
  sink: { icon: Zap, badgeClass: 'bg-destructive/10 text-destructive border-destructive/30' },
};

/** 污点传播链：source → 传播… → sink 的垂直步骤视图（结果页与规则实验室共用） */
export default function TaintFlow({ steps }: { steps: ITaintStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-1">
      {steps.map((step, index) => {
        const style = ROLE_STYLES[step.role];
        const Icon = style.icon;
        return (
          <div key={`${step.role}-${step.path}-${step.line}-${index}`}>
            {index > 0 && (
              <div className="ml-4 flex h-3 items-center">
                <ArrowDown className="size-3 text-muted-foreground/60" />
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
                  style.badgeClass,
                )}
              >
                <Icon className="size-3" />
                {TAINT_ROLE_LABELS[step.role]}
              </span>
              <span className="min-w-0 truncate font-mono text-xs text-foreground/90" title={step.path}>
                {step.path}:{step.line}
              </span>
              {step.text && (
                <code className="max-w-[240px] shrink truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {step.text}
                </code>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
