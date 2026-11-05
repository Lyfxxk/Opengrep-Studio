import type { AppLanguage } from '@/i18n';

const SKIN_STORAGE_KEY = '__global_opengrep_skin';

export type SkinId = 'default' | 'graphite';

export interface SkinDefinition {
  id: SkinId;
  labels: Record<AppLanguage, string>;
}

export const SKINS: SkinDefinition[] = [
  {
    id: 'default',
    labels: {
      zh: '群青',
      'zh-Hant': '群青',
      en: 'Ultramarine',
      ja: '群青',
      ko: '군청',
      ru: 'Ультрамарин',
      fr: 'Outremer',
      de: 'Ultramarin',
    },
  },
  {
    id: 'graphite',
    labels: {
      zh: '石墨',
      'zh-Hant': '石墨',
      en: 'Graphite',
      ja: 'グラファイト',
      ko: '그라파이트',
      ru: 'Графит',
      fr: 'Graphite',
      de: 'Graphit',
    },
  },
];

function isSkinId(value: string | null): value is SkinId {
  return value === 'default' || value === 'graphite';
}

export function resolveInitialSkin(): SkinId {
  try {
    const stored = localStorage.getItem(SKIN_STORAGE_KEY);
    if (isSkinId(stored)) return stored;
  } catch (error) {
    console.error('读取皮肤偏好失败:', String(error));
  }
  return 'default';
}

function applySkin(id: SkinId): void {
  if (id === 'default') {
    delete document.documentElement.dataset.skin;
  } else {
    document.documentElement.dataset.skin = id;
  }
}

export function changeAppSkin(id: SkinId): void {
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, id);
  } catch {
  }
  applySkin(id);
}
