import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const tokenSecret = process.env.AUTH_SECRET ?? 'dev-secret-change-me';
export const GUEST_USER_ID = 'guest';
let bcryptModule: { hashSync: (p: string, rounds: number) => string; compareSync: (p: string, hash: string) => boolean } | null | undefined;

function getBcryptModule() {
  if (bcryptModule !== undefined) return bcryptModule;
  try {
    // Optional dependency in this environment; fallback is PBKDF2 for compatibility.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    bcryptModule = require('bcryptjs');
  } catch {
    bcryptModule = null;
  }
  return bcryptModule;
}

export function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function hashPassword(password: string) {
  const bcrypt = getBcryptModule();
  if (bcrypt) {
    return `bcrypt:${bcrypt.hashSync(password, 10)}`;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2:${salt}:${digest}`;
}

export function verifyPassword(password: string, stored: string) {
  const bcrypt = getBcryptModule();
  if (stored.startsWith('bcrypt:')) {
    if (!bcrypt) return false;
    return bcrypt.compareSync(password, stored.slice('bcrypt:'.length));
  }

  const normalized = stored.startsWith('pbkdf2:') ? stored.slice('pbkdf2:'.length) : stored;
  const [salt, digest] = normalized.split(':');
  if (!salt || !digest) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(candidate, 'hex'));
}

export function signToken(userId: string) {
  const payload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyToken(token: string): string | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(encoded).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { sub: string; exp: number };
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export interface AuthedRequest extends Request {
  userId?: string;
}

export function getUserIdFromAuthHeader(req: Request): string | null {
  const authHeader = req.header('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  return verifyToken(token);
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = getUserIdFromAuthHeader(req);
  if (!userId) {
    res.status(401).json({ error: 'Missing or invalid bearer token' });
    return;
  }
  req.userId = userId;
  next();
}
