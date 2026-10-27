import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh';
import en from './en';

// 语言偏好键与 lib/auth.ts 的 __global_opengrep_* 命名保持一致
const LANG_STORAGE_KEY = '__global_opengrep_lang';

function resolveInitialLanguage(): 'zh' | 'en' {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  // 手动切换入口落地前：中文环境用中文，其余默认英文（面向开源传播）
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const initial = resolveInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: initial,
  // 文案抽词未完成：缺键回落中文源语言
  fallbackLng: 'zh',
  interpolation: { escapeValue: false }, // React 渲染已转义，无需重复转义
});

// <html lang> 跟随当前语言，供无障碍与字体回退使用
document.documentElement.lang = initial === 'zh' ? 'zh-CN' : 'en';

export default i18n;
