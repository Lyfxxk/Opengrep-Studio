import { useMemo, useState } from 'react';

/**
 * 列表批量选择状态：全选范围始终是当前列表（传入的 ids，含筛选后的结果）。
 * 列表刷新后，state 里已不在列表中的陈旧勾选会被 effective 集合过滤掉，不会误删。
 */
export function useRowSelection(ids: readonly string[]) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const present = useMemo(() => new Set(ids), [ids]);
  const selected = useMemo(
    () => new Set([...selectedIds].filter((id) => present.has(id))),
    [selectedIds, present],
  );

  const allSelected = ids.length > 0 && selected.size === ids.length;
  return {
    /** 当前生效的勾选集合（已过滤列表中不存在的 id） */
    selected,
    count: selected.size,
    allSelected,
    someSelected: selected.size > 0 && !allSelected,
    toggle(id: string): void {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll(): void {
      setSelectedIds(allSelected ? new Set() : present);
    },
    clear(): void {
      setSelectedIds(new Set());
    },
  };
}
