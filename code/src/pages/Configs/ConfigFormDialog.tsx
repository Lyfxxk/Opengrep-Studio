import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ConfigFormValues } from '@/lib/api';
import type { IConfig } from '@/data/configs';
import type { IRulePack } from '@/data/rulepacks';
import { cn } from '@/lib/utils';
import TagPathInput from './TagPathInput';

export interface ConfigDialogTarget {
  id?: string;
  values: ConfigFormValues;
}

interface ConfigFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ConfigDialogTarget | null;
  rulePacks: IRulePack[];
  existingConfigs: IConfig[];
  onSubmit: (values: ConfigFormValues, configId?: string) => void;
}

const EXCLUDE_PLACEHOLDER = 'node_modules/**、dist/**、**/*.min.js';

function bytesToMb(bytes: number): string {
  return String(Math.round((bytes / 1000000) * 10) / 10);
}

export default function ConfigFormDialog({
  open,
  onOpenChange,
  target,
  rulePacks,
  existingConfigs,
  onSubmit,
}: ConfigFormDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPacks, setSelectedPacks] = useState<string[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [includes, setIncludes] = useState<string[]>([]);
  const [timeoutSeconds, setTimeoutSeconds] = useState('5');
  const [jobs, setJobs] = useState('4');
  const [maxSizeMb, setMaxSizeMb] = useState('1');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isEditing = Boolean(target?.id);

  useEffect(() => {
    if (open && target) {
      setName(target.values.name);
      setDescription(target.values.description ?? '');
      setSelectedPacks(target.values.rulePackIds);
      setExcludes(target.values.excludes);
      setIncludes(target.values.includes);
      setTimeoutSeconds(String(target.values.timeoutSeconds));
      setJobs(String(target.values.jobs));
      setMaxSizeMb(bytesToMb(target.values.maxTargetBytes));
      setAdvancedOpen(false);
      // 编辑时若已勾选内置包，自动展开内置区让用户看到当前选择
      setBuiltinOpen(
        target.values.rulePackIds.some((packId) =>
          rulePacks.some((pack) => pack.id === packId && pack.builtin),
        ),
      );
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);

  const allPackIds = useMemo(() => rulePacks.map((pack) => pack.id), [rulePacks]);
  const allSelected = allPackIds.length > 0 && selectedPacks.length === allPackIds.length;
  const someSelected = selectedPacks.length > 0 && !allSelected;
  const customPacks = rulePacks.filter((pack) => !pack.builtin);
  const builtinPacks = rulePacks.filter((pack) => pack.builtin);
  const selectedBuiltinCount = builtinPacks.filter((pack) =>
    selectedPacks.includes(pack.id),
  ).length;

  const renderPackRow = (pack: IRulePack) => (
    <div
      key={pack.id}
      className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-muted/60"
    >
      <Checkbox
        id={`pack-${pack.id}`}
        checked={selectedPacks.includes(pack.id)}
        onCheckedChange={(checked) => togglePack(pack.id, checked === true)}
      />
      <Label
        htmlFor={`pack-${pack.id}`}
        className="min-w-0 flex-1 cursor-pointer text-sm font-normal leading-5"
      >
        {pack.name}
        <Badge
          variant="secondary"
          className="ml-1.5 inline-flex h-4 items-center rounded-sm px-1.5 align-middle text-[10px] font-normal text-muted-foreground"
        >
          {pack.language}
        </Badge>
      </Label>
      <span className="shrink-0 text-xs text-muted-foreground">
        {pack.ruleCount} 条规则
        {!pack.enabled && <span className="text-destructive"> · 已停用</span>}
      </span>
    </div>
  );

  const toggleAllPacks = (checked: boolean) => {
    setSelectedPacks(checked ? allPackIds : []);
    setErrors((prev) => ({ ...prev, rulePacks: '' }));
  };

  const togglePack = (packId: string, checked: boolean) => {
    setSelectedPacks((prev) =>
      checked ? [...prev, packId] : prev.filter((id) => id !== packId),
    );
    setErrors((prev) => ({ ...prev, rulePacks: '' }));
  };

  const handleSubmit = () => {
    const nextErrors: Record<string, string> = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      nextErrors.name = '请输入配置名称';
    } else if (trimmedName.length > 50) {
      nextErrors.name = '配置名称不超过 50 字';
    } else if (
      existingConfigs.some(
        (config) => config.name === trimmedName && config.id !== target?.id,
      )
    ) {
      nextErrors.name = '配置名称已存在';
    }
    if (description.trim().length > 200) {
      nextErrors.description = '描述不超过 200 字';
    }
    if (selectedPacks.length === 0) {
      nextErrors.rulePacks = '请至少勾选 1 个规则包';
    }
    const timeout = Number(timeoutSeconds);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
      nextErrors.timeout = '请输入 1–600 的整数';
    }
    const jobsValue = Number(jobs);
    if (!Number.isInteger(jobsValue) || jobsValue < 1 || jobsValue > 16) {
      nextErrors.jobs = '请输入 1–16 的整数';
    }
    const size = Number(maxSizeMb);
    if (Number.isNaN(size) || size < 0.1 || size > 100) {
      nextErrors.size = '请输入 0.1–100 之间的数值';
    }
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      return;
    }
    onSubmit(
      {
        name: trimmedName,
        description: description.trim(),
        rulePackIds: selectedPacks,
        excludes,
        includes,
        timeoutSeconds: timeout,
        jobs: jobsValue,
        maxTargetBytes: Math.round(size * 1000000),
      },
      target?.id,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑配置' : '新建配置'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="config-name">配置名称</Label>
            <Input
              id="config-name"
              value={name}
              maxLength={50}
              placeholder="如：上线前严格审计"
              onChange={(event) => {
                setName(event.target.value);
                setErrors((prev) => ({ ...prev, name: '' }));
              }}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="config-description">描述</Label>
            <Textarea
              id="config-description"
              value={description}
              maxLength={200}
              rows={2}
              placeholder="配置用途说明（可选，不超过 200 字）"
              onChange={(event) => {
                setDescription(event.target.value);
                setErrors((prev) => ({ ...prev, description: '' }));
              }}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>规则包</Label>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  已选 {selectedPacks.length}/{rulePacks.length}
                </span>
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="pack-select-all"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(checked) => toggleAllPacks(checked === true)}
                  />
                  <Label
                    htmlFor="pack-select-all"
                    className="cursor-pointer text-sm font-normal"
                  >
                    全选
                  </Label>
                </div>
              </div>
            </div>
            <div className="rounded-md border p-1.5">
              {customPacks.length > 0 ? (
                customPacks.map(renderPackRow)
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  暂无自定义规则包，可在「规则包」标签页创建或上传
                </p>
              )}

              {/* 内置包收纳进折叠区，与自定义勾选行区分父子层级 */}
              <button
                type="button"
                aria-expanded={builtinOpen}
                onClick={() => setBuiltinOpen((open) => !open)}
                className="mt-0.5 flex w-full items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-left text-sm font-medium transition-colors hover:bg-muted/60"
              >
                {builtinOpen ? (
                  <FolderOpen className="size-4 shrink-0 text-primary" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0">内置规则包</span>
                <Badge
                  variant="secondary"
                  className="shrink-0 px-1.5 text-[10px] font-normal"
                >
                  {builtinPacks.length} 个
                </Badge>
                {selectedBuiltinCount > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    已选 {selectedBuiltinCount}
                  </span>
                )}
                <ChevronDown
                  className={cn(
                    'ml-auto size-4 shrink-0 text-muted-foreground transition-transform',
                    builtinOpen && 'rotate-180',
                  )}
                />
              </button>
              {builtinOpen && (
                <div className="ml-5 mt-1 rounded-md bg-muted/25 p-1">
                  {builtinPacks.map(renderPackRow)}
                </div>
              )}
            </div>
            {errors.rulePacks && (
              <p className="text-xs text-destructive">{errors.rulePacks}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>排除路径</Label>
            <TagPathInput
              value={excludes}
              onChange={(next) => setExcludes(next)}
              placeholder={EXCLUDE_PLACEHOLDER}
            />
          </div>

          <div className="space-y-2">
            <Label>包含路径</Label>
            <TagPathInput
              value={includes}
              onChange={(next) => setIncludes(next)}
              placeholder="仅扫描这些路径（可选，如 src/**）"
            />
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1 text-sm font-medium">
              <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
              高级参数
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="config-timeout">单文件超时</Label>
                  <div className="relative">
                    <Input
                      id="config-timeout"
                      type="number"
                      min={1}
                      max={600}
                      value={timeoutSeconds}
                      className="pr-10"
                      onChange={(event) => {
                        setTimeoutSeconds(event.target.value);
                        setErrors((prev) => ({ ...prev, timeout: '' }));
                      }}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      秒
                    </span>
                  </div>
                  {errors.timeout && (
                    <p className="text-xs text-destructive">{errors.timeout}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="config-jobs">并发数</Label>
                  <Input
                    id="config-jobs"
                    type="number"
                    min={1}
                    max={16}
                    value={jobs}
                    onChange={(event) => {
                      setJobs(event.target.value);
                      setErrors((prev) => ({ ...prev, jobs: '' }));
                    }}
                  />
                  {errors.jobs && (
                    <p className="text-xs text-destructive">{errors.jobs}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="config-size">文件体积上限</Label>
                  <div className="relative">
                    <Input
                      id="config-size"
                      type="number"
                      min={0.1}
                      max={100}
                      step={0.1}
                      value={maxSizeMb}
                      className="pr-10"
                      onChange={(event) => {
                        setMaxSizeMb(event.target.value);
                        setErrors((prev) => ({ ...prev, size: '' }));
                      }}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      MB
                    </span>
                  </div>
                  {errors.size && (
                    <p className="text-xs text-destructive">{errors.size}</p>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit}>{isEditing ? '保存修改' : '创建配置'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
