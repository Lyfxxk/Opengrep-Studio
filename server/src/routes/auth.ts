import { Router, type Request, type Response } from 'express';
import {
  deleteUser,
  getUserById,
  getUserByUsername,
  insertUser,
  listUsers,
  updateUserPassword,
  updateUserRole,
  type Role,
  type User,
} from '../db.js';
import { HttpError } from '../errors.js';
import {
  clearSessionCookie,
  getSessionUser,
  hashPassword,
  issueSessionCookie,
  requireRole,
  verifyPassword,
} from '../auth.js';
import { asyncHandler, newId } from './shared.js';

export const authRoutes = Router();

const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function requireValidUsername(raw: unknown): string {
  const username = String(raw ?? '').trim();
  if (!username || username.length > 50 || !USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, '用户名须为 1-50 个字符，仅限字母、数字、下划线与连字符', {
      code: 'srv.usernameInvalid',
    });
  }
  return username;
}

function requireValidPassword(raw: unknown): string {
  const password = String(raw ?? '');
  if (password.length < 6 || password.length > 100) {
    throw new HttpError(400, '密码长度须为 6-100 个字符', { code: 'srv.passwordInvalid' });
  }
  return password;
}

function requireValidRole(raw: unknown): Role {
  if (raw !== 'admin' && raw !== 'auditor' && raw !== 'viewer') {
    throw new HttpError(400, '角色仅支持 admin / auditor / viewer', { code: 'srv.roleInvalid' });
  }
  return raw;
}

function requireTargetUser(id: string): User {
  const user = getUserById(id);
  if (!user) {
    throw new HttpError(404, '用户不存在或已被删除', { code: 'srv.userNotFound' });
  }
  return user;
}

function requireManageableTarget(target: User, operator: { uid: string } | undefined): void {
  if (operator && target.id === operator.uid) {
    throw new HttpError(409, '不能对自己执行此操作（不可删除自己或修改自己的角色）', {
      code: 'srv.selfProtected',
    });
  }
  if (target.username === 'admin') {
    throw new HttpError(409, '初始管理员账号不可删除、不可修改角色，仅可重置密码', {
      code: 'srv.adminProtected',
    });
  }
}

function publicUser(user: User): { id: string; username: string; role: Role; createdAt: string } {
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

authRoutes.post('/api/auth/login', asyncHandler(async (req: Request, res: Response) => {
  const username = String(req.body?.username ?? '');
  const password = String(req.body?.password ?? '');
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, '用户名或密码错误', { code: 'srv.authInvalid' });
  }
  issueSessionCookie(res, user);
  res.json({ username: user.username, role: user.role });
}));

authRoutes.post('/api/auth/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.status(204).end();
});

authRoutes.get('/api/auth/me', (req: Request, res: Response) => {
  const user = getSessionUser(req);
  if (!user) throw new HttpError(401, '请先登录后再访问接口', { code: 'srv.authRequired' });
  res.json({ username: user.username, role: user.role });
});

authRoutes.get('/api/users', requireRole('admin'), (_req: Request, res: Response) => {
  res.json(listUsers().map(publicUser));
});

authRoutes.post('/api/users', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const username = requireValidUsername(req.body?.username);
  const password = requireValidPassword(req.body?.password);
  const role = requireValidRole(req.body?.role);
  if (getUserByUsername(username)) {
    throw new HttpError(409, '用户名已存在', { code: 'srv.userExists' });
  }
  const user: User = {
    id: newId('user'),
    username,
    passwordHash: hashPassword(password),
    role,
    createdAt: new Date().toISOString(),
  };
  insertUser(user);
  res.status(201).json(publicUser(user));
}));

authRoutes.patch('/api/users/:id', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const target = requireTargetUser(req.params.id);
  const operator = getSessionUser(req);
  const rawRole = req.body?.role;
  const rawPassword = req.body?.password;
  if (rawRole === undefined && rawPassword === undefined) {
    throw new HttpError(400, '需要 role 或 password 字段', { code: 'srv.badRequest' });
  }
  let nextRole: Role | undefined;
  if (rawRole !== undefined) {
    requireManageableTarget(target, operator);
    nextRole = requireValidRole(rawRole);
  }
  let nextPasswordHash: string | undefined;
  if (rawPassword !== undefined) {
    nextPasswordHash = hashPassword(requireValidPassword(rawPassword));
  }
  if (nextRole !== undefined) updateUserRole(target.id, nextRole);
  if (nextPasswordHash !== undefined) updateUserPassword(target.id, nextPasswordHash);
  const refreshed = requireTargetUser(target.id);
  res.json(publicUser(refreshed));
}));

authRoutes.delete('/api/users/:id', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const target = requireTargetUser(req.params.id);
  const operator = getSessionUser(req);
  requireManageableTarget(target, operator);
  deleteUser(target.id);
  res.status(204).end();
}));
