import { expect, test } from '@playwright/test';
import { loginAs } from './support/session';

const ADMIN = { username: 'admin', password: '123456' };

test('未登录访问受保护路由会跳到登录页', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('#login-username')).toBeVisible();
});

test('密码错误时给出提示且停留在登录页', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#login-username').fill(ADMIN.username);
  await page.locator('#login-password').fill('definitely-wrong');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('登录后进入工作台，新标签页凭会话 cookie 恢复登录', async ({ page, context }) => {
  await page.goto('/login');
  await page.locator('#login-username').fill(ADMIN.username);
  await page.locator('#login-password').fill(ADMIN.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

  const session = (await context.cookies()).find((cookie) => cookie.name === 'og_session');
  expect(session?.httpOnly).toBe(true);

  const freshTab = await context.newPage();
  await freshTab.goto('/dashboard');
  await expect(freshTab).toHaveURL(/\/dashboard$/);
  await expect(freshTab.locator('a[href="/projects"]')).toBeVisible();
  await freshTab.close();
});

test('登出后会话失效并回到登录页', async ({ page, context }) => {
  await loginAs(context);
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('user-menu-logout').click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).find((cookie) => cookie.name === 'og_session')).toBeUndefined();

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
