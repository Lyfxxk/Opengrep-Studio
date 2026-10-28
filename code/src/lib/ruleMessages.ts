import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { USE_MOCK } from '@/lib/api';

type RuleMessageMap = Record<string, string>;

const cache = new Map<string, Promise<RuleMessageMap>>();

/** 规则说明只有简繁两份：繁体走繁体表，其余语言沿用中文表（与改造前行为一致） */
function messagePath(language: string): string {
  return language.startsWith('zh-Hant') ? '/api/messages-zh-Hant' : '/api/messages-zh';
}

function loadOnce(path: string): Promise<RuleMessageMap> {
  // 演示模式无后端，消息表请求必然失败，直接短路避免每次渲染发出注定 404 的请求
  if (USE_MOCK) return Promise.resolve({});
  const cached = cache.get(path);
  if (cached) return cached;
  // 刻意不走 lib/api 客户端：消息表是纯增强数据（命中翻译），失败须静默降级为空表并按路径缓存，
  // 不弹错、不重试；api.request 的抛错语义在这里反而是负担
  const pending = fetch(path)
    .then((res) => (res.ok ? (res.json() as Promise<RuleMessageMap>) : {}))
    .catch(() => ({}));
  cache.set(path, pending);
  return pending;
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
  const { i18n } = useTranslation();
  const path = messagePath(i18n.resolvedLanguage ?? i18n.language);
  const [map, setMap] = useState<RuleMessageMap>({});
  useEffect(() => {
    let mounted = true;
    // 切语言先清空，避免上一语言的消息表在新语言页面上残留
    setMap({});
    void loadOnce(path).then((loaded) => {
      if (mounted) setMap(loaded);
    });
    return () => {
      mounted = false;
    };
  }, [path]);
  return map;
}
