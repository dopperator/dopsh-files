import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.UPLOAD_TOKEN ?? '';

if (!TOKEN) {
  console.warn('[auth] UPLOAD_TOKEN is empty; /api/upload/* endpoints will reject all requests.');
}

interface Attempt { count: number; firstAt: number; bannedUntil: number; }
const attempts = new Map<string, Attempt>();

const WINDOW_MS = 60_000;
const MAX_FAILS = 5;
const BAN_MS = 15 * 60_000;

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkBearer(req: Request, ip: string): { ok: true } | { ok: false; status: number; body: string } {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.bannedUntil > now) return { ok: false, status: 429, body: 'rate limited' };

  if (!TOKEN) return { ok: false, status: 503, body: 'server missing UPLOAD_TOKEN' };

  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  const ok = !!m && eq(m[1], TOKEN);

  if (ok) {
    attempts.delete(ip);
    return { ok: true };
  }

  if (!rec || now - rec.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now, bannedUntil: 0 });
  } else {
    rec.count += 1;
    if (rec.count >= MAX_FAILS) {
      rec.bannedUntil = now + BAN_MS;
    }
  }
  return { ok: false, status: 401, body: 'unauthorized' };
}

export function checkUploadToken(sent: string | null, expected: string | null): boolean {
  if (!sent || !expected) return false;
  return eq(sent, expected);
}
