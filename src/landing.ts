import type { FileRow } from './db.ts';

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? 'https://dop.sh').replace(/\/$/, '');

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function relativeDate(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function renderLanding(row: FileRow, downloadUrl: string): string {
  const title = escape(row.orig_name);
  const desc = `${humanSize(row.size)} · Uploaded ${relativeDate(row.uploaded_at)}`;
  const url = `${PUBLIC_BASE}/u/${row.slug}`;
  const mime = escape(row.mime);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} — dop.sh</title>
<meta name="description" content="${escape(desc)}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${escape(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${url}" />
<meta name="twitter:card" content="summary" />
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --border:#e5e5e5; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e0e10; --fg:#e7e7e7; --muted:#999; --border:#2a2a2e; --accent:#60a5fa; } }
  body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--fg); display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { max-width:520px; width:100%; border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { margin:0 0 8px; font-size:20px; word-break:break-all; }
  .meta { color:var(--muted); font-size:14px; margin-bottom:20px; }
  .meta div { margin-top:2px; }
  a.btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; padding:10px 16px; border-radius:8px; font-weight:500; }
  a.btn:hover { opacity:0.9; }
  .foot { margin-top:20px; font-size:12px; color:var(--muted); }
  .foot a { color:var(--muted); }
</style>
</head>
<body>
  <main class="card">
    <h1>${title}</h1>
    <div class="meta">
      <div>${humanSize(row.size)}</div>
      <div>${mime}</div>
      <div>Uploaded ${relativeDate(row.uploaded_at)}</div>
    </div>
    <a class="btn" href="${escape(downloadUrl)}" download="${title}">Download</a>
    <div class="foot"><a href="/">dop.sh</a></div>
  </main>
</body>
</html>`;
}
