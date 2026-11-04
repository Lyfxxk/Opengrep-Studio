import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, SwatchBook } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AppLanguage } from '@/i18n';
import {
  SKINS,
  changeAppSkin,
  resolveInitialSkin,
  type SkinDefinition,
  type SkinId,
} from '@/skins';

function skinLabel(skin: SkinDefinition, lang: string): string {
  const label = skin.labels[lang as AppLanguage];
  return typeof label === 'string' ? label : skin.labels.en;
}

export default function SkinMenu({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  const [skin, setSkin] = useState<SkinId>(resolveInitialSkin);
  const active = SKINS.find((item) => item.id === skin) ?? SKINS[0];
  const activeLabel = skinLabel(active, current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('header.skin')}
          title={t('header.skin')}
          className={className}
        >
          <SwatchBook className="size-4" />
          <span className="hidden sm:inline">{activeLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SKINS.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => {
              changeAppSkin(item.id);
              setSkin(item.id);
            }}
          >
            {item.id === active.id && <Check className="size-4" />}
            {skinLabel(item, current)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
