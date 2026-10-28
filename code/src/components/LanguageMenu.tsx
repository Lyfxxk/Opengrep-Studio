import { useTranslation } from 'react-i18next';
import { Check, Languages } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { changeAppLanguage, type AppLanguage } from '@/i18n';

// 语言列表集中在此：新增语言只改这一处，按钮文案与勾选态自动跟随
const LANGUAGES: Array<{ code: AppLanguage; labelKey: 'lang.zh' | 'lang.zhHant' | 'lang.en' }> = [
  { code: 'zh', labelKey: 'lang.zh' },
  { code: 'zh-Hant', labelKey: 'lang.zhHant' },
  { code: 'en', labelKey: 'lang.en' },
];

/** 语言切换下拉（Header 与登录页共用）；触发按钮样式由调用方通过 className 定制 */
export default function LanguageMenu({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  // 用 resolvedLanguage 而非 language：自定义标签（zh-Hant）解析后仍能精确匹配，避免勾选态错位
  const current = i18n.resolvedLanguage ?? i18n.language;
  const active = LANGUAGES.find((item) => item.code === current) ?? LANGUAGES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('header.language')}
          title={t('header.language')}
          className={className}
        >
          <Languages className="size-4" />
          <span className="hidden sm:inline">{t(active.labelKey)}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((item) => (
          <DropdownMenuItem key={item.code} onSelect={() => changeAppLanguage(item.code)}>
            {item.code === active.code && <Check className="size-4" />}
            {t(item.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
