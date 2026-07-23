import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { q, type FileRow } from '../src/db.ts';
import { resolveMime, extFromFilename } from '../src/mime.ts';
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
import { createSignedUploadUrl, getPublicUrl, deleteObject, supabaseAvailable, bucketFor, SUPABASE_BUCKET_MEDIA, SUPABASE_BUCKET_FILES } from '../src/supabase.ts';

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

async function proxyFromSupabase(
  req: Request,
  targetUrl: string,
  overrideHeaders: Record<string, string>,
): Promise<Response> {
  const fwd: Record<string, string> = {};
  const range = req.headers.get('range');
  if (range) fwd.range = range;

  const upstream = await fetch(targetUrl, { headers: fwd });

  const out = new Headers();
  // Preserve these from Supabase response
  for (const k of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  out.set('cache-control', 'public, max-age=31536000, immutable');
  for (const [k, v] of Object.entries(overrideHeaders)) out.set(k, v);

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function serveFileWithRange(
  req: Request,
  filepath: string,
  size: number,
  baseHeaders: Record<string, string>,
): Response {
  const range = req.headers.get('range');
  const file = Bun.file(filepath);
  const base = { ...baseHeaders, 'accept-ranges': 'bytes' };

  if (!range) {
    return new Response(file, { headers: { ...base, 'content-length': String(size) } });
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return new Response(file, { headers: { ...base, 'content-length': String(size) } });

  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : size - 1;
  if (start >= size || end >= size || start > end) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    });
  }

  const slice = file.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      ...base,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    },
  });
}

function supabasePath(slug: string, ext: string): string {
  return `${slug}.${ext}`;
}

function publicViewUrl(slug: string, ext: string): string {
  const entry = resolveMime(ext);
  return entry.mode === 'media'
    ? `${PUBLIC_BASE}/u/${slug}.${ext}`
    : `${PUBLIC_BASE}/f/${slug}.${ext}`;
}

function bucketForRow(row: FileRow): string {
  return bucketFor(resolveMime(row.ext).mode);
}

function supabaseDownloadUrl(row: FileRow): string {
  return `${getPublicUrl(bucketForRow(row), supabasePath(row.slug, row.ext))}?download=${encodeURIComponent(row.orig_name)}`;
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
  const mimeEntry = resolveMime(ext);

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

  const viewUrl = publicViewUrl(slug, ext);

  if (storage === 'supabase') {
    try {
      const bucket = bucketFor(mimeEntry.mode);
      const { uploadUrl, token } = await createSignedUploadUrl(bucket, supabasePath(slug, ext));
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
    return json({ ok: true, viewUrl: publicViewUrl(row.slug, row.ext) });
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
  return json({ ok: true, viewUrl: publicViewUrl(slug, row.ext) });
}

async function handleDelete(req: Request, slug: string, ip: string): Promise<Response> {
  const auth = checkBearer(req, ip);
  if (!auth.ok) return text(auth.body, auth.status);
  if (!SLUG_RE.test(slug)) return text('bad slug', 400);

  const row = q.getBySlug.get(slug);
  if (!row) return json({ ok: true });

  if (row.storage === 'supabase') {
    try { await deleteObject(bucketForRow(row), supabasePath(row.slug, row.ext)); } catch (e) { console.error('supabase delete err', e); }
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
      storage: r.storage, uploaded_at: r.uploaded_at, viewUrl: publicViewUrl(r.slug, r.ext),
    })),
  });
}

function handleMediaEmbed(req: Request, slug: string, extOpt: string | null): Response | Promise<Response> {
  if (!SLUG_RE.test(slug)) return text('not found', 404);
  const row = q.getBySlug.get(slug);
  if (!row || row.status !== 'ready') return text('not found', 404);

  // /u/<slug> with no extension → 404 (landing page removed)
  if (extOpt === null) return text('not found', 404);
  if (extOpt !== row.ext) return text('not found', 404);

  const mimeEntry = resolveMime(row.ext);

  // Non-media at /u/ → redirect to /f/ for back-compat
  if (mimeEntry.mode !== 'media') {
    return Response.redirect(`${PUBLIC_BASE}/f/${row.slug}.${row.ext}`, 302);
  }

  // Media: serve inline, proxying Supabase through us so the URL stays at dop.sh
  if (row.storage === 'supabase') {
    const src = getPublicUrl(bucketForRow(row), supabasePath(row.slug, row.ext));
    return proxyFromSupabase(req, src, { 'content-type': row.mime });
  }
  return serveFileWithRange(req, localPath(row.slug, row.ext), row.size, {
    'content-type': row.mime,
    'cache-control': 'public, max-age=31536000, immutable',
  });
}

function handleFileDownload(req: Request, slug: string, extOpt: string): Response | Promise<Response> {
  if (!SLUG_RE.test(slug)) return text('not found', 404);
  const row = q.getBySlug.get(slug);
  if (!row || row.status !== 'ready') return text('not found', 404);
  if (extOpt !== row.ext) return text('not found', 404);

  if (row.storage === 'supabase') {
    const src = getPublicUrl(bucketForRow(row), supabasePath(row.slug, row.ext));
    return proxyFromSupabase(req, src, {
      'content-type': row.mime,
      'content-disposition': `attachment; filename="${row.orig_name.replace(/"/g, '')}"`,
    });
  }
  return serveFileWithRange(req, localPath(row.slug, row.ext), row.size, {
    'content-type': row.mime,
    'content-disposition': `attachment; filename="${row.orig_name.replace(/"/g, '')}"`,
    'cache-control': 'public, max-age=31536000, immutable',
  });
}

// ---------- dispatcher ----------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // seconds; upper bound for long uploads
  maxRequestBodySize: HARD_MAX, // Bun defaults to 128 MB, which would reject local-tier uploads
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = clientIp(req, srv.requestIP(req)?.address ?? 'unknown');

    // health
    if (path === '/healthz') return text('ok');

    const isRead = req.method === 'GET' || req.method === 'HEAD';

    // /u/:slug(.:ext)? — media embed (non-media redirects to /f/)
    {
      const m = /^\/u\/([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]+))?$/.exec(path);
      if (m && isRead) {
        return handleMediaEmbed(req, m[1], m[2] ?? null);
      }
    }

    // /f/:slug.:ext — force download
    {
      const m = /^\/f\/([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$/.exec(path);
      if (m && isRead) return handleFileDownload(req, m[1], m[2]);
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
console.log(`[dopsh-files] supabase: ${supabaseAvailable() ? `enabled (media=${SUPABASE_BUCKET_MEDIA}, files=${SUPABASE_BUCKET_FILES})` : 'DISABLED (fill SUPABASE_URL/SUPABASE_SERVICE_KEY in .env)'}`);
console.log(`[dopsh-files] caps: supabase<=${SUPABASE_MAX} local<=${HARD_MAX} total-local<=${TOTAL_LOCAL_CAP}`);
