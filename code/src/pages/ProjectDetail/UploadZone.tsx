import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2, FileArchive, GitBranch, RotateCcw, Upload } from 'lucide-react';
import LanguageStatsBar from '@/components/LanguageStatsBar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import type { UploadItem } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface UploadZoneState {
  status: 'idle' | 'uploading' | 'uploaded';
  /** 来源：upload=压缩包/文件夹上传，clone=Git 仓库直扫克隆 */
  sourceType?: 'upload' | 'clone';
  fileName?: string;
  fileSize?: number;
  progress?: number;
  /** 上传时按 .gitignore 忽略规则剪枝掉的文件数（仅 upload 来源） */
  ignoredCount?: number;
}

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_FILE_COUNT = 50000;

/** 点击选择的压缩包格式（与后端 ARCHIVE_EXTS 一致） */
const ARCHIVE_RE = /\.(zip|7z|rar|tar|tar\.gz|tgz)$/i;

interface UploadZoneProps {
  state: UploadZoneState;
  /** 最近一次上传的语言分布（语言 → 字节数），上传成功后展示 */
  languageStats?: Record<string, number>;
  onSelectItems: (items: UploadItem[], options: { respectGitignore: boolean }) => void;
  onClone: (url: string, ref: string) => void;
  onReset: () => void;
}

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024).toFixed(1)} KB`;
}

/** 把拖拽进来的文件/目录（含嵌套子目录）展开成 文件+相对路径 列表 */
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
  /** 默认按 .gitignore 过滤上传内容（与 Git 仓库直扫口径一致），可显式关闭以深挖被忽略文件 */
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
    // 只拦根级别混选（拖了压缩包+文件夹）；文件夹内部嵌套的压缩包是正常源码附件，放行
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
    // 散装文件 / 文件夹：逐个校验大小
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
          // 拖拽经过子元素同样触发 dragLeave：只有指针真正离开容器时才取消高亮，避免闪烁
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
      <p className="mt-2 text-xs text-muted-foreground">{t('upload.cloneHint')}</p>
    </div>
  );
}
