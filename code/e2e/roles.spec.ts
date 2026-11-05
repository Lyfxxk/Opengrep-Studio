import { expect, test, type BrowserContext } from '@playwright/test';
import { createUser, loginAs } from './support/session';

const PASSWORD = 'e2e-pass-123456';

let seq = 0;
function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

async function createProjectAsAdmin(context: BrowserContext, name: string): Promise<string> {
  await loginAs(context);
  const response = await context.request.post('/api/projects', { data: { name } });
  expect(response.status(), '创建项目失败').toBe(201);
  const project = (await response.json()) as { id: string };
  return project.id;
}

test('viewer 看不到写操作与管理员入口', async ({ page, context }) => {
  const username = uniqueName('viewer');
  const projectId = await createProjectAsAdmin(context, uniqueName('viewer-proj'));
  await createUser(context, username, 'viewer', PASSWORD);
  await loginAs(context, username, PASSWORD);

  await page.goto('/projects');
  await expect(page.locator('a[href="/projects"]')).toBeVisible();
  await expect(page.locator('a[href="/rules"]')).toHaveCount(0);
  await expect(page.locator('a[href="/configs"]')).toHaveCount(0);
  await expect(page.getByTestId('project-create')).toHaveCount(0);

  await page.goto('/users');
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTestId('start-scan')).toHaveCount(0);
  await expect(page.locator('input[type="file"][accept*=".zip"]')).toHaveCount(0);
});

test('auditor 可写但无用户管理', async ({ page, context }) => {
  const username = uniqueName('auditor');
  const projectId = await createProjectAsAdmin(context, uniqueName('auditor-proj'));
  await createUser(context, username, 'auditor', PASSWORD);
  await loginAs(context, username, PASSWORD);

  await page.goto('/projects');
  await expect(page.getByTestId('project-create')).toBeVisible();
  await expect(page.locator('a[href="/rules"]')).toBeVisible();
  await expect(page.locator('a[href="/configs"]')).toBeVisible();

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTestId('start-scan')).toBeVisible();
  await expect(page.locator('input[type="file"][accept*=".zip"]')).toHaveCount(1);

  await page.goto('/users');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('admin 可在用户管理页新建用户', async ({ page, context }) => {
  const username = uniqueName('ui-user');
  await loginAs(context);

  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('user-menu-users').click();
  await expect(page).toHaveURL(/\/users$/);

  await page.getByTestId('user-create-open').click();
  await page.locator('#user-username').fill(username);
  await page.locator('#user-password').fill(PASSWORD);
  await page.getByTestId('user-create-submit').click();

  await expect(page.getByRole('cell', { name: username, exact: true })).toBeVisible();
});
