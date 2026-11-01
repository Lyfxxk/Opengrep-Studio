const AUTH_KEY = '__global_opengrep_auth';
const USERNAME_KEY = '__global_opengrep_username';

const store = sessionStorage;

const LOCAL_ACCOUNT = { username: 'admin', password: '123456' } as const;

export function validateCredentials(username: string, password: string): boolean {
  return username === LOCAL_ACCOUNT.username && password === LOCAL_ACCOUNT.password;
}

export function isAuthenticated(): boolean {
  try {
    return store.getItem(AUTH_KEY) === '1';
  } catch (error) {
    console.error('读取登录态失败:', String(error));
    return false;
  }
}

export function login(username: string): void {
  try {
    store.setItem(AUTH_KEY, '1');
    store.setItem(USERNAME_KEY, username);
  } catch (error) {
    console.error('写入登录态失败:', String(error));
  }
}

export function logout(): void {
  try {
    store.removeItem(AUTH_KEY);
    store.removeItem(USERNAME_KEY);
  } catch (error) {
    console.error('清除登录态失败:', String(error));
  }
}

export function getCurrentUsername(): string {
  try {
    return store.getItem(USERNAME_KEY) || 'admin';
  } catch (error) {
    console.error('读取当前用户失败:', String(error));
    return 'admin';
  }
}
