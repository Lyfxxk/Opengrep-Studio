import { expect, test } from '@playwright/test';
import { loginAs } from './support/session';

const LANGUAGES = [
  { code: 'zh', htmlLang: 'zh-CN' },
  { code: 'zh-Hant', htmlLang: 'zh-Hant' },
  { code: 'en', htmlLang: 'en' },
  { code: 'ja', htmlLang: 'ja' },
  { code: 'ko', htmlLang: 'ko' },
];

test('语言菜单切换后 html lang 更新且刷新后保持', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/dashboard');

  await page.getByTestId('language-menu-trigger').click();
  await page.getByTestId('language-ja').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('a[href="/projects"]')).toBeVisible();
});

test('五种语言切换后无裸露文案键', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/dashboard');

  for (const language of LANGUAGES) {
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      ['__global_opengrep_lang', language.code] as const,
    );
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', language.htmlLang);
    const text = await page.locator('body').innerText();
    expect(text, `${language.code} 出现裸露文案键`).not.toMatch(/\b(?:nav|common|header)\./);
  }
});
