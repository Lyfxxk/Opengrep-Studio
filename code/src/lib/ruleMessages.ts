import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { USE_MOCK } from '@/lib/api';

type RuleMessageMap = Record<string, string>;

const cache = new Map<string, Promise<RuleMessageMap>>();

function messagePath(language: string): string | null {
  if (language.startsWith('zh-Hant')) return '/api/messages-zh-Hant';
  return language.startsWith('zh') ? '/api/messages-zh' : null;
}

function loadOnce(path: string): Promise<RuleMessageMap> {
  if (USE_MOCK) return Promise.resolve({});
  const cached = cache.get(path);
  if (cached) return cached;
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
