import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2, FileArchive, GitBranch, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import type { UploadItem } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface UploadZoneState {
  status: 'idle' | 'uploading' | 'uploaded';
  sourceType?: 'upload' | 'clone';
  fileName?: string;
  fileSize?: number;
  progress?: number;
  ignoredCount?: number;
}

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_FILE_COUNT = 50000;

const ARCHIVE_RE = /\.(zip|7z|rar|tar|tar\.gz|tgz)$/i;

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

const TOP_N = 6;

interface UploadZoneProps {
  state: UploadZoneState;
  languageStats?: Record<string, number>;
  onSelectItems: (items: UploadItem[], options: { respectGitignore: boolean }) => void;
  onClone: (url: string, ref: string) => void;
  onReset: () => void;
}

function formatFileSize(size: number): string {
  if (size >= 1000 * 1000) {
    return `${(size / 1000 / 1000).toFixed(1)} MB`;
  }
  return `${(size / 1000).toFixed(1)} KB`;
}

async function collectFromDataTransfer(dt: DataTransfer): Promise<{
  items: UploadItem[];
  rootCount: number;
  rootArchiveCount: number;
}> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    const files = Array.from(dt.files ?? []).map((file) => ({ file }));
    return {
      items: files,
      rootCount: files.length,
      rootArchiveCount: files.filter((item) => ARCHIVE_RE.test(item.file.name)).length,
    };
  }

  const out: UploadItem[] = [];
  let rootArchiveCount = 0;
  const walkEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push({ file, relativePath: `${prefix}${entry.name}` });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readAll = async (): Promise<FileSystemEntry[]> => {
        const acc: FileSystemEntry[] = [];
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          if (batch.length === 0) return acc;
          acc.push(...batch);
        }
      };
      for (const child of await readAll()) {
        await walkEntry(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) {
    if (entry.isFile && ARCHIVE_RE.test(entry.name)) rootArchiveCount += 1;
    await walkEntry(entry, '');
  }
  return { items: out, rootCount: entries.length, rootArchiveCount };
}

function LanguageStatsBar({ stats }: { stats: Record<string, number> }) {
  const { t } = useTranslation();
  const total = Object.values(stats).reduce((sum, bytes) => sum + bytes, 0);
  if (total <= 0) return null;
  const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, TOP_N).map(([language, bytes], index) => ({
    language,
    percent: (bytes / total) * 100,
    color: LANG_COLORS[language] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length],
  }));
  const rest = sorted.slice(TOP_N).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (rest > 0) {
    const fallbackIndex = TOP_N % FALLBACK_COLORS.length;
    head.push({ language: 'Other', percent: (rest / total) * 100, color: FALLBACK_COLORS[fallbackIndex] });
  }

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
          {t('langStats.total', { kb: (total / 1000).toFixed(1) })}
        </span>
      </div>
    </div>
  );
}

export default function UploadZone({
  state,
  languageStats,
  onSelectItems,
  onClone,
  onReset,
}: UploadZoneProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [respectIgnore, setRespectIgnore] = useState(true);

  const submitClone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = repoUrl.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
    } catch {
      toast.error(t('upload.invalidUrl'));
      return;
    }
    onClone(url, branch.trim());
  };

  const pickArchive = (file: File | undefined) => {
    if (!file) return;
    if (!ARCHIVE_RE.test(file.name)) {
      toast.error(t('upload.invalidArchive'));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error(t('upload.tooLarge', { limit: MAX_FILE_SIZE / 1024 / 1024 }));
      return;
    }
    onSelectItems([{ file }], { respectGitignore: respectIgnore });
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    let collected: { items: UploadItem[]; rootCount: number; rootArchiveCount: number };
    try {
      collected = await collectFromDataTransfer(event.dataTransfer);
    } catch {
      toast.error(t('upload.readFailed'));
      return;
    }
    const { items, rootCount, rootArchiveCount } = collected;
    if (items.length === 0) return;
    if (items.length > MAX_FILE_COUNT) {
      toast.error(t('upload.tooManyFiles', { limit: MAX_FILE_COUNT }));
      return;
    }
    if (rootCount > 1 && rootArchiveCount > 0) {
      toast.error(t('upload.archiveMixed'));
      return;
    }
    const isSingleArchive =
      rootCount === 1 && rootArchiveCount === 1 && items.length === 1;
    if (isSingleArchive) {
      if (items[0].file.size > MAX_FILE_SIZE) {
        toast.error(t('upload.tooLarge', { limit: MAX_FILE_SIZE / 1024 / 1024 }));
        return;
      }
      onSelectItems([{ file: items[0].file }], { respectGitignore: respectIgnore });
      return;
    }
    for (const item of items) {
      if (item.file.size > MAX_FILE_SIZE) {
        toast.error(t('upload.fileTooLarge', { name: item.file.name, limit: MAX_FILE_SIZE / 1024 / 1024 }));
        return;
      }
    }
    onSelectItems(items, { respectGitignore: respectIgnore });
  };

  if (state.status === 'uploaded') {
    return (
      <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-success/30 bg-success/10 p-5 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <CheckCircle2 className="size-8 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{state.fileName}</div>
            <div className="text-xs text-muted-foreground">
              {state.fileSize ? formatFileSize(state.fileSize) : ''}
              {state.sourceType === 'clone'
                ? ` · ${t('upload.cloneDone')}`
                : state.ignoredCount
                  ? ` · ${t('upload.uploadedIgnored', { count: state.ignoredCount })}`
                  : ` · ${t('upload.uploadedReady')}`}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1"
            onClick={onReset}
          >
            <RotateCcw className="size-3.5" />
            {t('upload.reselect')}
          </Button>
        </div>
        {languageStats && (
          <div className="min-w-0 flex-1 border-success/20 lg:border-l lg:pl-5">
            <LanguageStatsBar stats={languageStats} />
          </div>
        )}
      </div>
    );
  }

  if (state.status === 'uploading') {
    if (state.sourceType === 'clone') {
      return (
        <div className="rounded-lg border border-border bg-muted/40 p-6">
          <div className="flex min-w-0 items-center gap-3">
            <GitBranch className="size-8 shrink-0 animate-pulse text-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{state.fileName}</div>
              <div className="text-xs text-muted-foreground">
                {t('upload.cloning')}
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-6">
        <div className="flex min-w-0 items-center gap-3">
          <FileArchive className="size-8 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{state.fileName}</div>
            <div className="text-xs text-muted-foreground">
              {state.fileSize ? formatFileSize(state.fileSize) : ''} · {t('upload.uploading')}
            </div>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {state.progress ?? 0}%
          </span>
        </div>
        <Progress value={state.progress ?? 0} />
      </div>
    );
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDragActive(false);
          }
        }}
        onDrop={(event) => void handleDrop(event)}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 text-center transition-colors',
          dragActive
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-muted/40',
        )}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
          <Upload className="size-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium">{t('upload.dropTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('upload.dropHint', { limit: MAX_FILE_SIZE / 1024 / 1024 })}
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.7z,.rar,.tar,.tar.gz,.tgz"
        className="hidden"
        onChange={(event) => {
          pickArchive(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <label
        htmlFor="respect-gitignore"
        className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-muted/40"
      >
        <Checkbox
          id="respect-gitignore"
          checked={respectIgnore}
          onCheckedChange={(checked) => setRespectIgnore(checked === true)}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('upload.respectIgnoreTitle')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {respectIgnore ? t('upload.ignoreOn') : t('upload.ignoreOff')}
          </span>
        </span>
      </label>
      <form
        onSubmit={submitClone}
        className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center"
      >
        <div className="relative min-w-0 flex-1">
          <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/owner/repo.git"
            className="pl-9"
          />
        </div>
        <Input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={t('upload.branchPlaceholder')}
          className="sm:w-44"
        />
        <Button type="submit" variant="outline" className="shrink-0 gap-1" disabled={!repoUrl.trim()}>
          <GitBranch className="size-4" />
          {t('upload.cloneButton')}
        </Button>
      </form>
    </div>
  );
}
