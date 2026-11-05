import { useTranslation } from 'react-i18next';
import { Check, Languages } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { changeAppLanguage, type AppLanguage } from '@/i18n';

const LANGUAGES: Array<{
  code: AppLanguage;
  labelKey: 'lang.zh' | 'lang.zhHant' | 'lang.en' | 'lang.ja' | 'lang.ko';
}> = [
  { code: 'zh', labelKey: 'lang.zh' },
  { code: 'zh-Hant', labelKey: 'lang.zhHant' },
  { code: 'en', labelKey: 'lang.en' },
  { code: 'ja', labelKey: 'lang.ja' },
  { code: 'ko', labelKey: 'lang.ko' },
];

export default function LanguageMenu({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  const active = LANGUAGES.find((item) => item.code === current) ?? LANGUAGES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="language-menu-trigger"
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
          <DropdownMenuItem
            key={item.code}
            data-testid={`language-${item.code}`}
            onSelect={() => changeAppLanguage(item.code)}
          >
            {item.code === active.code && <Check className="size-4" />}
            {t(item.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
