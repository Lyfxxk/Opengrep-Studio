import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** 各语言的品牌色（GitHub Linguist 风格），未收录的语言按名称哈希取备用色 */
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Vue: '#41b883',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Less: '#cc6699',
  Python: '#3572A5',
  Java: '#b07219',
  Go: '#00ADD8',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Rust: '#dea584',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Shell: '#89e051',
  Dockerfile: '#384d54',
  SQL: '#e38c00',
  YAML: '#cb171e',
  JSON: '#40566e',
  Markdown: '#083fa1',
  XML: '#0060ac',
  TOML: '#9c4221',
  INI: '#d1dbe0',
  Gradle: '#02303a',
};

const FALLBACK_COLORS = ['#8b949e', '#a371f7', '#7ee787', '#ffa657', '#79c0ff', '#f778ba'];

function colorOf(language: string, index: number): string {
  return LANG_COLORS[language] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

/** 图例展示的语言数上限（其余聚合为 Other） */
const TOP_N = 6;

interface LanguageStatsBarProps {
  /** 语言 → 字节数（后端实测统计） */
  stats: Record<string, number>;
}

export default function LanguageStatsBar({ stats }: LanguageStatsBarProps) {
  const { t } = useTranslation();
  const segments = useMemo(() => {
    const total = Object.values(stats).reduce((sum, bytes) => sum + bytes, 0);
    if (total <= 0) return null;
    const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
    const head = sorted.slice(0, TOP_N).map(([language, bytes], index) => ({
      language,
      percent: (bytes / total) * 100,
      color: colorOf(language, index),
    }));
    const rest = sorted.slice(TOP_N).reduce((sum, [, bytes]) => sum + bytes, 0);
    if (rest > 0) {
      head.push({ language: 'Other', percent: (rest / total) * 100, color: colorOf('Other', TOP_N) });
    }
    return { head, total };
  }, [stats]);

  if (!segments) return null;
  const { head, total } = segments;

  return (
    <div className="min-w-0">
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {head.map((seg) => (
          <span
            key={seg.language}
            style={{ width: `${seg.percent}%`, backgroundColor: seg.color }}
            className="h-full"
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
        {head.map((seg) => (
          <span key={seg.language} className="flex items-center gap-1.5 text-xs">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: seg.color }}
            />
            <span className="font-medium">{seg.language}</span>
            <span className="tabular-nums text-muted-foreground">
              {seg.percent.toFixed(1)}%
            </span>
          </span>
        ))}
        <span className="text-xs text-muted-foreground">
          {t('langStats.total', { kb: (total / 1024).toFixed(0) })}
        </span>
      </div>
    </div>
  );
}
