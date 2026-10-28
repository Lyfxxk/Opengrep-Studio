import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { USE_MOCK } from '@/lib/api';

type RuleMessageMap = Record<string, string>;

const cache = new Map<string, Promise<RuleMessageMap>>();

/** 中文语境才套用中文说明表：繁体走繁体表，英文直接用引擎原文，避免英文界面里冒出中文 */
function messagePath(language: string): string | null {
  if (language.startsWith('zh-Hant')) return '/api/messages-zh-Hant';
  return language.startsWith('zh') ? '/api/messages-zh' : null;
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
    // 切语言先清空，避免上一语言的消息表在新语言页面上残留
    setMap({});
    if (!path) return;
    let mounted = true;
    void loadOnce(path).then((loaded) => {
      if (mounted) setMap(loaded);
    });
    return () => {
      mounted = false;
    };
  }, [path]);
  return map;
}
