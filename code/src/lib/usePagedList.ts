import { useEffect, useState } from 'react';

/**
 * 分页夹取：筛选变严或增删数据后页码可能越界（如只剩一页），渲染前夹回有效范围
 * 并同步回状态，保证不落在空页上。页码状态由 hook 持有，每次调用是独立实例，
 * 同一组件可对多份列表各自翻页。
 */
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
