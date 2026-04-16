import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { q, type FileRow } from '../src/db.ts';
import { lookupMime, extFromFilename } from '../src/mime.ts';
import { checkBearer, checkUploadToken } from '../src/auth.ts';
import {
  pickStorage,
  localPath,
  partPath,
  finalizeLocal,
  removeLocal,
  assertDiskAvailable,
  FILES_DIR,
  HARD_MAX,
  SUPABASE_MAX,
  TOTAL_LOCAL_CAP,
} from '../src/storage.ts';
import { createSignedUploadUrl, getPublicUrl, deleteObject, supabaseAvailable, SUPABASE_BUCKET } from '../src/supabase.ts';
import { renderLanding } from '../src/landing.ts';

const PORT = Number(process.env.PORT ?? 4100);
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? 'https://dop.sh').replace(/\/$/, '');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function slugifyStem(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]+$/, '');
  const s = stem
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'file';
}

function uniqueSlug(base: string): string {
  if (!q.getBySlug.get(base)) return base;
  for (let i = 2; i <= 9; i++) {
    const s = `${base}-${i}`;
    if (!q.getBySlug.get(s)) return s;
  }
  return `${base}-${randomBytes(3).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

function clientIp(req: Request, addr: string): string {
  return (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()) || addr || 'unknown';
}

function supabasePath(slug: string, ext: string): string {
  return `${slug}.${ext}`;
}

function downloadUrlFor(row: FileRow): string {
  if (row.storage === 'supabase') return getPublicUrl(supabasePath(row.slug, row.ext));
  return `${PUBLIC_BASE}/u/${row.slug}.${row.ext}?dl=1`;
}

// ---------- route handlers ----------

async function handleInit(req: Request, ip: string): Promise<Response> {
  const auth = checkBearer(req, ip);
  if (!auth.ok) return text(auth.body, auth.status);

  let body: { filename?: string; size?: number; mime?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { filename, size, mime } = body;
  if (!filename || typeof filename !== 'string') return json({ error: 'filename required' }, 400);
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return json({ error: 'size must be positive integer' }, 400);

  const ext = extFromFilename(filename);
  if (!ext) return json({ error: 'no extension' }, 400);
  const mimeEntry = lookupMime(ext);
  if (!mimeEntry) return json({ error: `unsupported extension: .${ext}` }, 400);

  if (size > HARD_MAX) return json({ error: `exceeds max file size ${HARD_MAX}` }, 413);

  let storage = pickStorage(size);
  if (!storage) return json({ error: 'invalid size' }, 400);

  // Fall back to local if Supabase isn't configured
  if (storage === 'supabase' && !supabaseAvailable()) storage = 'local';

  if (storage === 'local') {
    const total = q.totalLocalReady.get()?.total ?? 0;
    if (total + size > TOTAL_LOCAL_CAP) return json({ error: 'local storage cap reached' }, 507);
    try { await assertDiskAvailable(size); } catch (e) { return json({ error: String((e as Error).message) }, 507); }
  }

  const slug = uniqueSlug(slugifyStem(filename));

  const uploadToken = storage === 'local' ? randomBytes(24).toString('base64url') : null;
  const now = Math.floor(Date.now() / 1000);

  q.insert.run(slug, ext, mimeEntry.mime, size, filename, storage, now, ip, uploadToken);

  const viewUrl = `${PUBLIC_BASE}/u/${slug}.${ext}`;

  if (storage === 'supabase') {
    try {
      const { uploadUrl, token } = await createSignedUploadUrl(supabasePath(slug, ext));
      return json({ slug, storage: 'supabase', viewUrl, uploadUrl, uploadToken: token });
    } catch (e) {
      q.delete.run(slug);
      return json({ error: `supabase error: ${(e as Error).message}` }, 502);
    }
  }

  return json({
    slug,
    storage: 'local',
    viewUrl,
    streamUrl: `${PUBLIC_BASE}/api/upload/stream/${slug}`,
    uploadToken,
  });
}

async function handleStream(req: Request, slug: string, ip: string): Promise<Response> {
  const auth = checkBearer(req, ip);
  if (!auth.ok) return text(auth.body, auth.status);
  if (!SLUG_RE.test(slug)) return text('bad slug', 400);

  const row = q.getBySlug.get(slug);
  if (!row) return text('not found', 404);
  if (row.status !== 'pending') return text('not pending', 409);
  if (row.storage !== 'local') return text('wrong tier', 400);

  const sent = req.headers.get('x-upload-token');
  if (!checkUploadToken(sent, row.upload_token)) return text('bad upload token', 403);

  // consume the token immediately so it can't be replayed even mid-upload
  q.consumeUploadToken.run(slug);

  if (!req.body) return text('no body', 400);

  const target = partPath(row.slug, row.ext);
  const out = createWriteStream(target, { flags: 'wx' });
  let written = 0;

  try {
    const readable = Readable.fromWeb(req.body as any);
    readable.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > row.size) readable.destroy(new Error('exceeds declared size'));
    });
    await pipeline(readable, out);

    if (written !== row.size) throw new Error(`size mismatch: declared ${row.size}, got ${written}`);

    finalizeLocal(row.slug, row.ext);
    q.markReady.run(null, row.slug);
    return json({ ok: true, viewUrl: `${PUBLIC_BASE}/u/${row.slug}.${row.ext}` });
  } catch (e) {
    removeLocal(row.slug, row.ext);
    q.delete.run(row.slug);
    return json({ error: (e as Error).message }, 400);
  }
}

async function handleComplete(req: Request, ip: string): Promise<Response> {
  const auth = checkBearer(req, ip);
  if (!auth.ok) return text(auth.body, auth.status);

  let body: { slug?: string; sha256?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const slug = body.slug;
  if (!slug || !SLUG_RE.test(slug)) return json({ error: 'bad slug' }, 400);

  const row = q.getBySlug.get(slug);
  if (!row) return json({ error: 'not found' }, 404);
  if (row.storage !== 'supabase') return json({ error: 'complete only for supabase tier' }, 400);
  if (row.status === 'ready') return json({ ok: true });

  q.markReady.run(body.sha256 ?? null, slug);
  return json({ ok: true, viewUrl: `${PUBLIC_BASE}/u/${slug}.${row.ext}` });
}

async function handleDelete(req: Request, slug: string, ip: string): Promise<Response> {
  const auth = checkBearer(req, ip);
  if (!auth.ok) return text(auth.body, auth.status);
  if (!SLUG_RE.test(slug)) return text('bad slug', 400);

  const row = q.getBySlug.get(slug);
  if (!row) return json({ ok: true });

  if (row.storage === 'supabase') {
    try { await deleteObject(supabasePath(row.slug, row.ext)); } catch (e) { console.error('supabase delete err', e); }
  } else {
    removeLocal(row.slug, row.ext);
  }
  q.delete.run(slug);
  return json({ ok: true });
}

function handleList(req: Request, ip: string): Response {
  const auth = checkBearer(req, ip);
  if (!auth.ok) return text(auth.body, auth.status);
  const url = new URL(req.url);
  const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
  const rows = q.listReady.all(limit, offset);
  return json({
    files: rows.map(r => ({
      slug: r.slug, ext: r.ext, mime: r.mime, size: r.size, orig_name: r.orig_name,
      storage: r.storage, uploaded_at: r.uploaded_at, viewUrl: `${PUBLIC_BASE}/u/${r.slug}.${r.ext}`,
    })),
  });
}

function handleGet(req: Request, slug: string, extOpt: string | null): Response | Promise<Response> {
  if (!SLUG_RE.test(slug)) return text('not found', 404);
  const row = q.getBySlug.get(slug);
  if (!row || row.status !== 'ready') return text('not found', 404);

  const url = new URL(req.url);
  const wantsDownload = url.searchParams.get('dl') === '1';
  const mimeEntry = lookupMime(row.ext);

  // URL without extension → always landing
  if (extOpt === null) {
    return new Response(renderLanding(row, downloadUrlFor(row)), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // URL ext doesn't match stored ext → 404
  if (extOpt !== row.ext) return text('not found', 404);

  // Media → serve bytes (local) or redirect (supabase)
  if (mimeEntry?.mode === 'media' && !wantsDownload) {
    if (row.storage === 'supabase') {
      return Response.redirect(getPublicUrl(supabasePath(row.slug, row.ext)), 302);
    }
    const file = Bun.file(localPath(row.slug, row.ext));
    return new Response(file, {
      headers: {
        'content-type': row.mime,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // Non-media OR explicit download
  if (wantsDownload && row.storage === 'local') {
    const file = Bun.file(localPath(row.slug, row.ext));
    return new Response(file, {
      headers: {
        'content-type': row.mime,
        'content-disposition': `attachment; filename="${row.orig_name.replace(/"/g, '')}"`,
        'accept-ranges': 'bytes',
      },
    });
  }

  // Non-media landing page
  return new Response(renderLanding(row, downloadUrlFor(row)), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// ---------- dispatcher ----------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // seconds; upper bound for long uploads
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = clientIp(req, srv.requestIP(req)?.address ?? 'unknown');

    // health
    if (path === '/healthz') return text('ok');

    // /u/:slug(.:ext)? — public read
    {
      const m = /^\/u\/([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]+))?$/.exec(path);
      if (m && req.method === 'GET') {
        return handleGet(req, m[1], m[2] ?? null);
      }
    }

    // /api/upload/init
    if (path === '/api/upload/init' && req.method === 'POST') return handleInit(req, ip);

    // /api/upload/stream/:slug
    {
      const m = /^\/api\/upload\/stream\/([A-Za-z0-9_-]+)$/.exec(path);
      if (m && req.method === 'PUT') return handleStream(req, m[1], ip);
    }

    // /api/upload/complete
    if (path === '/api/upload/complete' && req.method === 'POST') return handleComplete(req, ip);

    // /api/files/:slug  DELETE
    {
      const m = /^\/api\/files\/([A-Za-z0-9_-]+)$/.exec(path);
      if (m && req.method === 'DELETE') return handleDelete(req, m[1], ip);
    }

    // /api/files (GET list)
    if (path === '/api/files' && req.method === 'GET') return handleList(req, ip);

    return text('not found', 404);
  },
});

console.log(`[dopsh-files] listening on :${server.port}`);
console.log(`[dopsh-files] files dir: ${FILES_DIR}`);
console.log(`[dopsh-files] supabase: ${supabaseAvailable() ? `enabled (bucket=${SUPABASE_BUCKET})` : 'DISABLED (fill SUPABASE_URL/SUPABASE_SERVICE_KEY in .env)'}`);
console.log(`[dopsh-files] caps: supabase<=${SUPABASE_MAX} local<=${HARD_MAX} total-local<=${TOTAL_LOCAL_CAP}`);
