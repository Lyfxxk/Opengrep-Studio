import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// 模式列表集中在此：图标与文案随模式走，新增模式只改这一处
const THEMES = [
  { mode: 'light', labelKey: 'theme.light', Icon: Sun },
  { mode: 'dark', labelKey: 'theme.dark', Icon: Moon },
  { mode: 'system', labelKey: 'theme.system', Icon: Monitor },
] as const;

/**
 * 主题切换下拉（仅应用内 Header 使用；登录页是独立的暗色设计，不跟随主题）。
 * 触发按钮样式由调用方通过 className 定制，与 LanguageMenu 保持一致。
 */
export default function ThemeMenu({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  // next-themes 在挂载后才读 localStorage，首帧 theme 为 undefined：按 defaultTheme（light）兜底
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
