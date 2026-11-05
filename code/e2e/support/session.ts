import { expect, type BrowserContext } from '@playwright/test';

export interface SessionUser {
  username: string;
  role: 'admin' | 'auditor' | 'viewer';
}

export async function loginAs(
  context: BrowserContext,
  username = 'admin',
  password = '123456',
): Promise<SessionUser> {
  const response = await context.request.post('/api/auth/login', {
    data: { username, password },
  });
  expect(response.ok(), `登录失败 ${username}: HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()) as SessionUser;
}

export async function createUser(
  context: BrowserContext,
  username: string,
  role: SessionUser['role'],
  password = 'e2e-pass-123456',
): Promise<void> {
  const response = await context.request.post('/api/users', {
    data: { username, password, role },
  });
  expect(response.status(), `创建用户失败 ${username}`).toBe(201);
}
