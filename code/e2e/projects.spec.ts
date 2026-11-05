import path from 'node:path';
import { expect, test } from '@playwright/test';
import { loginAs } from './support/session';

const SAMPLE_ZIP = path.resolve(import.meta.dirname, 'fixtures', 'sample-source.zip');

test('通过界面创建项目并出现在列表中', async ({ page, context }) => {
  const name = `ui-project-${Date.now().toString(36)}`;
  await loginAs(context);

  await page.goto('/projects');
  await page.getByTestId('project-create').click();
  await page.locator('#project-name').fill(name);
  await page.getByTestId('project-create-submit').click();

  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
});

test('上传源码包后展示文件名与语言统计', async ({ page, context }) => {
  const name = `upload-${Date.now().toString(36)}`;
  await loginAs(context);
  const created = await context.request.post('/api/projects', { data: { name } });
  expect(created.status(), '创建项目失败').toBe(201);
  const project = (await created.json()) as { id: string };

  await page.goto(`/projects/${project.id}`);
  await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(SAMPLE_ZIP);

  await expect(page.getByText('sample-source.zip')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('JavaScript', { exact: true })).toBeVisible();
  await expect(page.getByText('Python', { exact: true })).toBeVisible();
});
