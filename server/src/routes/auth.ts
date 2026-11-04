import { Router, type Request, type Response } from 'express';
import { getUserByUsername } from '../db.js';
import { HttpError } from '../errors.js';
import {
  clearSessionCookie,
  getSessionUser,
  issueSessionCookie,
  verifyPassword,
} from '../auth.js';
import { asyncHandler } from './shared.js';

export const authRoutes = Router();

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
