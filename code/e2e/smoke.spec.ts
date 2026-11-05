import { expect, test } from '@playwright/test';
import { loginAs } from './support/session';

test('@smoke 登录会话可进入工作台', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('a[href="/projects"]')).toBeVisible();
});
