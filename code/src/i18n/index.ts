import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh';
import zhHant from './zh-Hant';
import en from './en';
import ja from './ja';
import ko from './ko';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof zh };
  }
}

const LANG_STORAGE_KEY = '__global_opengrep_lang';

export type AppLanguage = 'zh' | 'zh-Hant' | 'en' | 'ja' | 'ko';

const HTML_LANG: Record<AppLanguage, string> = {
  zh: 'zh-CN',
  'zh-Hant': 'zh-Hant',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
};

function isAppLanguage(value: string | null): value is AppLanguage {
  return (
    value === 'zh' || value === 'zh-Hant' || value === 'en' || value === 'ja' || value === 'ko'
  );
}

function detectLanguage(tag: string): AppLanguage {
  const lower = tag.toLowerCase();
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('ko')) return 'ko';
  if (!lower.startsWith('zh')) return 'en';
  return /^zh-(tw|hk|mo|hant)/.test(lower) ? 'zh-Hant' : 'zh';
}

function resolveInitialLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (isAppLanguage(stored)) return stored;
  } catch (error) {
    console.error('读取语言偏好失败:', String(error));
  }
  return detectLanguage(navigator.language || '');
}

const initial = resolveInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    'zh-Hant': { translation: zhHant },
    en: { translation: en },
    ja: { translation: ja },
    ko: { translation: ko },
  },
  lng: initial,
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
});

document.documentElement.lang = HTML_LANG[initial];
document.title = i18n.t('title.app');

export function changeAppLanguage(lang: AppLanguage): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
  }
  document.documentElement.lang = HTML_LANG[lang];
  document.title = i18n.t('title.app', { lng: lang });
}

export default i18n;
