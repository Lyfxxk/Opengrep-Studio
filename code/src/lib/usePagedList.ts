import { useEffect, useState } from 'react';

export function usePagedList<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  useEffect(() => {
    setPage(safePage);
  }, [safePage]);
  const start = (safePage - 1) * pageSize;
  return {
    page: safePage,
    setPage,
    pageCount,
    slice: items.slice(start, start + pageSize),
  };
}
