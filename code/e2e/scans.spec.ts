import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type BrowserContext } from '@playwright/test';
import { loginAs } from './support/session';

const SAMPLE_ZIP = path.resolve(import.meta.dirname, 'fixtures', 'sample-source.zip');

async function setupProjectWithSource(context: BrowserContext, name: string): Promise<string> {
  await loginAs(context);

  const projectResponse = await context.request.post('/api/projects', { data: { name } });
  expect(projectResponse.status(), '创建项目失败').toBe(201);
  const project = (await projectResponse.json()) as { id: string };

  const packsResponse = await context.request.get('/api/rulepacks');
  const packs = (await packsResponse.json()) as Array<{ id: string }>;
  const jsPack = packs.find((pack) => pack.id === 'builtin-js-ts') ?? packs[0];

  const configResponse = await context.request.post('/api/configs', {
    data: {
      name: `cfg-${name}`,
      rulePackIds: [jsPack.id],
      timeoutSeconds: 30,
      jobs: 1,
      maxTargetBytes: 1_000_000,
    },
  });
  expect(configResponse.status(), `创建扫描配置失败: ${await configResponse.text()}`).toBe(201);
  const config = (await configResponse.json()) as { id: string };

  const bindResponse = await context.request.patch(`/api/projects/${project.id}`, {
    data: { configId: config.id },
  });
  expect(bindResponse.ok(), '绑定扫描配置失败').toBeTruthy();

  const uploadResponse = await context.request.post(`/api/projects/${project.id}/source`, {
    multipart: {
      file: {
        name: 'sample-source.zip',
        mimeType: 'application/zip',
        buffer: await fs.readFile(SAMPLE_ZIP),
      },
    },
  });
  expect(uploadResponse.ok(), '上传源码失败').toBeTruthy();

  return project.id;
}

test('@engine 发起扫描并在扫描结果与报告中看到问题', async ({ page, context }) => {
  const projectId = await setupProjectWithSource(context, `scan-${Date.now().toString(36)}`);

  await page.goto(`/projects/${projectId}`);
  await page.getByTestId('start-scan').click();

  await expect(page.getByTestId('scan-status').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('scan-status').first()).toHaveAttribute('data-status', 'completed', {
    timeout: 240_000,
  });

  const issueCount = Number(await page.getByTestId('scan-issue-count').first().innerText());
  expect(issueCount, '扫描未发现问题').toBeGreaterThan(0);

  await page.getByTestId('scan-issue-count').first().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/scans\/[^/]+$/);
  await expect(page.getByText('src/app.js', { exact: false }).first()).toBeVisible();

  await page.goto(`${page.url()}/report`);
  await expect(page.getByText('src/app.js', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});
