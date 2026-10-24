const AUTH_KEY = '__global_opengrep_auth';
const USERNAME_KEY = '__global_opengrep_username';

// sessionStorage 仅在当前标签页内有效：关掉页面/重开浏览器即失效，每次启动都需重新登录
const store = sessionStorage;

// 固定本地账号：仅为防误触的前端门禁，不是安全机制（后端接口无鉴权，服务只监听本机）。
// 登录页已显著标注此声明；若要接入鉴权请另行设计，不要简单替换这里的常量。
export const LOCAL_ACCOUNT = { username: 'admin', password: '123456' } as const;

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
    store.setItem(AUTH_KEY, '');
    store.setItem(USERNAME_KEY, '');
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
