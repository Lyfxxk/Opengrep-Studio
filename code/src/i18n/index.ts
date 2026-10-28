import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh';
import zhHant from './zh-Hant';
import en from './en';

// 键类型全局生效：t() 只接受 zh.ts 中存在的键，拼错键/错层级在编译期报错
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof zh };
  }
}

// 语言偏好键与 lib/auth.ts 的 __global_opengrep_* 命名保持一致
const LANG_STORAGE_KEY = '__global_opengrep_lang';

export type AppLanguage = 'zh' | 'zh-Hant' | 'en';

// <html lang> 决定浏览器按哪种字形渲染（Han 统一码下 zh-CN 会用简体字形），同时影响无障碍与字体回退
const HTML_LANG: Record<AppLanguage, string> = {
  zh: 'zh-CN',
  'zh-Hant': 'zh-Hant',
  en: 'en',
};

function isAppLanguage(value: string | null): value is AppLanguage {
  return value === 'zh' || value === 'zh-Hant' || value === 'en';
}

/** 浏览器语言标签 → 应用语言：台/港/澳等繁体地区归入 zh-Hant，其余中文归简体 */
function detectLanguage(tag: string): AppLanguage {
  const lower = tag.toLowerCase();
  if (!lower.startsWith('zh')) return 'en';
  return /^zh-(tw|hk|mo|hant)/.test(lower) ? 'zh-Hant' : 'zh';
}

function resolveInitialLanguage(): AppLanguage {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (isAppLanguage(stored)) return stored;
  // 手动切换入口落地前：中文环境用中文，其余默认英文（面向开源传播）
  return detectLanguage(navigator.language || '');
}

const initial = resolveInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    'zh-Hant': { translation: zhHant },
    en: { translation: en },
  },
  lng: initial,
  // 文案抽词分批进行：缺键回落中文源语言
  fallbackLng: 'zh',
  interpolation: { escapeValue: false }, // React 渲染已转义，无需重复转义
});

// <html lang> 与标签页标题跟随当前语言，供无障碍与字体回退使用；标题随后会被各页面覆盖
document.documentElement.lang = HTML_LANG[initial];
document.title = i18n.t('title.app');

/** 切换语言并持久化：语言资源、localStorage、<html lang>、标签页标题一处同步 */
export function changeAppLanguage(lang: AppLanguage): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // 隐身模式等 localStorage 不可用场景：仅当前会话生效，不阻断切换
  }
  document.documentElement.lang = HTML_LANG[lang];
  document.title = i18n.t('title.app', { lng: lang });
}

export default i18n;
