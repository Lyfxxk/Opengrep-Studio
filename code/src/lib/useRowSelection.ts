import { useMemo, useState } from 'react';

export function useRowSelection(ids: readonly string[]) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const present = useMemo(() => new Set(ids), [ids]);
  const selected = useMemo(
    () => new Set([...selectedIds].filter((id) => present.has(id))),
    [selectedIds, present],
  );

  const allSelected = ids.length > 0 && selected.size === ids.length;
  return {
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
      setSelectedIds(allSelected ? new Set() : new Set(present));
    },
    clear(): void {
      setSelectedIds(new Set());
    },
  };
}
