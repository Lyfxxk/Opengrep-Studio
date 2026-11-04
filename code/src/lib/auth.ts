import { USE_MOCK, authApi, type SessionUser, type UserRole } from '@/lib/api';

const AUTH_KEY = '__global_opengrep_auth';

const store = sessionStorage;

const LOCAL_ACCOUNT = { username: 'admin', password: '123456' } as const;

const ROLES: UserRole[] = ['admin', 'auditor', 'viewer'];

export function validateCredentials(username: string, password: string): boolean {
  return username === LOCAL_ACCOUNT.username && password === LOCAL_ACCOUNT.password;
}

export function getCurrentUser(): SessionUser | null {
  try {
    const raw = store.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionUser> | null;
    if (parsed && typeof parsed.username === 'string' && ROLES.includes(parsed.role as UserRole)) {
      return { username: parsed.username, role: parsed.role as UserRole };
    }
  } catch (error) {
    console.error('Failed to read auth state:', String(error));
  }
  return null;
}

export function getCurrentUsername(): string {
  return getCurrentUser()?.username ?? '';
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, auditor: 2, admin: 3 };

export function hasRole(minimum: UserRole): boolean {
  const role = getCurrentUser()?.role;
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

function storeUser(user: SessionUser): void {
  try {
    store.setItem(AUTH_KEY, JSON.stringify(user));
  } catch (error) {
    console.error('Failed to write auth state:', String(error));
  }
}

export function clearCurrentUser(): void {
  try {
    store.removeItem(AUTH_KEY);
  } catch (error) {
    console.error('Failed to clear auth state:', String(error));
  }
}

export async function login(username: string, password: string): Promise<SessionUser> {
  if (USE_MOCK) {
    const user: SessionUser = { username, role: 'admin' };
    storeUser(user);
    return user;
  }
  const user = await authApi.login(username, password);
  storeUser(user);
  return user;
}

export async function logout(): Promise<void> {
  if (!USE_MOCK) {
    await authApi.logout().catch(() => undefined);
  }
  clearCurrentUser();
}

export async function restoreSession(): Promise<SessionUser | null> {
  const cached = getCurrentUser();
  if (cached) return cached;
  if (USE_MOCK) return null;
  try {
    const user = await authApi.me();
    storeUser(user);
    return user;
  } catch {
    return null;
  }
}
