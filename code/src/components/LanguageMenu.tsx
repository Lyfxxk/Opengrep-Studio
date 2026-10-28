import { useTranslation } from 'react-i18next';
import { Check, Languages } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { changeAppLanguage } from '@/i18n';

/** 中英文切换下拉（Header 与登录页共用）；触发按钮样式由调用方通过 className 定制 */
export default function LanguageMenu({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
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
          <span className="hidden sm:inline">{isZh ? t('lang.zh') : t('lang.en')}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => changeAppLanguage('zh')}>
          {isZh && <Check className="size-4" />}
          {t('lang.zh')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeAppLanguage('en')}>
          {!isZh && <Check className="size-4" />}
          {t('lang.en')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
