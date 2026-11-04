import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getUserById, insertUser, listUsers, type Role, type User } from './db.js';
import { newId } from './routes/shared.js';

const SESSION_COOKIE = 'og_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

export interface SessionUser {
  uid: string;
  username: string;
  role: Role;
}

interface SessionPayload {
  uid: string;
  username: string;
  role: Role;
  pv: string;
  exp: number;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

let authSecret: string | undefined;

function loadAuthSecret(): string {
  if (authSecret) return authSecret;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const secretPath = path.join(config.dataDir, 'auth-secret');
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (SECRET_PATTERN.test(existing)) {
      authSecret = existing;
      return authSecret;
    }
  } catch {
  }
  authSecret = randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, authSecret, 'utf8');
  return authSecret;
}

function sign(value: string): string {
  return createHmac('sha256', loadAuthSecret()).update(value).digest('base64url');
}

function passwordStamp(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

export function issueSessionCookie(res: Response, user: User): void {
  const payload: SessionPayload = {
    uid: user.id,
    username: user.username,
    role: user.role,
    pv: passwordStamp(user.passwordHash),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${body}.${sign(body)}`;
  res.appendHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.appendHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'auditor' || value === 'viewer';
}

function parseSessionToken(token: string | undefined): SessionPayload | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(body), 'base64url');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return undefined;
    if (typeof payload.uid !== 'string' || typeof payload.username !== 'string') return undefined;
    if (!isRole(payload.role) || typeof payload.pv !== 'string') return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function getSessionUser(req: Request): SessionUser | undefined {
  const payload = parseSessionToken(readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!payload) return undefined;
  const user = getUserById(payload.uid);
  if (!user) return undefined;
  if (user.username !== payload.username || user.role !== payload.role) return undefined;
  if (passwordStamp(user.passwordHash) !== payload.pv) return undefined;
  return { uid: user.id, username: user.username, role: user.role };
}

export function ensureInitialAdmin(): void {
  if (listUsers().length > 0) return;
  insertUser({
    id: newId('user'),
    username: 'admin',
    passwordHash: hashPassword('123456'),
    role: 'admin',
    createdAt: new Date().toISOString(),
  });
  console.log('[auth] users 空表，已播种初始管理员 admin（默认密码 123456，请登录后尽快修改）');
}
