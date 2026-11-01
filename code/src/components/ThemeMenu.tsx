import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const THEMES = [
  { mode: 'light', labelKey: 'theme.light', Icon: Sun },
  { mode: 'dark', labelKey: 'theme.dark', Icon: Moon },
  { mode: 'system', labelKey: 'theme.system', Icon: Monitor },
] as const;

export default function ThemeMenu({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const active = THEMES.find((item) => item.mode === theme) ?? THEMES[0];
  const ActiveIcon = active.Icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('header.theme')}
          title={t('header.theme')}
          className={className}
        >
          <ActiveIcon className="size-4" />
          <span className="hidden sm:inline">{t(active.labelKey)}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEMES.map((item) => (
          <DropdownMenuItem key={item.mode} onSelect={() => setTheme(item.mode)}>
            {item.mode === active.mode && <Check className="size-4" />}
            {t(item.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
