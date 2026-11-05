import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.tmp/results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: './e2e/.tmp/report', open: 'never' }],
  ],
  use: {
    baseURL,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], baseURL },
    },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    cwd: import.meta.dirname,
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
