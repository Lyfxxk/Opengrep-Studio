import { useEffect, useState } from 'react';
import { USE_MOCK } from '@/lib/api';

type RuleMessageMap = Record<string, string>;

let cache: Promise<RuleMessageMap> | null = null;

function loadOnce(): Promise<RuleMessageMap> {
  // 演示模式无后端，消息表请求必然失败，直接短路避免每次渲染发出注定 404 的请求
  if (USE_MOCK) return Promise.resolve({});
  // 刻意不走 lib/api 客户端：消息表是纯增强数据（命中翻译），失败须静默降级为空表并模块级缓存，
  // 不弹错、不重试；api.request 的抛错语义在这里反而是负担
  cache ??= fetch('/api/messages-zh')
    .then((res) => (res.ok ? (res.json() as Promise<RuleMessageMap>) : {}))
    .catch(() => ({}));
  return cache;
}

export function lookupRuleMessage(
  map: RuleMessageMap,
  checkId: string,
  fallback: string,
): string {
  const segments = checkId.split('.');
  for (let i = 0; i < segments.length; i += 1) {
    const hit = map[segments.slice(i).join('.')];
    if (hit) return hit;
  }
  return fallback;
}

export function useRuleMessageMap(): RuleMessageMap {
  const [map, setMap] = useState<RuleMessageMap>({});
  useEffect(() => {
    let mounted = true;
    void loadOnce().then((loaded) => {
      if (mounted) setMap(loaded);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return map;
}
