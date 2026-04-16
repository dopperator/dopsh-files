import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FileRow {
  slug: string;
  ext: string;
  mime: string;
  size: number;
  orig_name: string;
  sha256: string | null;
  storage: 'supabase' | 'local';
  status: 'pending' | 'ready' | 'deleted';
  uploaded_at: number;
  owner_ip: string | null;
  upload_token: string | null;
}

const DB_PATH = process.env.DB_PATH ?? './data/meta.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    slug         TEXT PRIMARY KEY,
    ext          TEXT NOT NULL,
    mime         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    orig_name    TEXT NOT NULL,
    sha256       TEXT,
    storage      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    uploaded_at  INTEGER NOT NULL,
    owner_ip     TEXT,
    upload_token TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files(uploaded_at);
  CREATE INDEX IF NOT EXISTS idx_files_status      ON files(status);
  CREATE INDEX IF NOT EXISTS idx_files_storage     ON files(storage);
`);

export const q = {
  insert: db.prepare<void, [string, string, string, number, string, string, number, string | null, string | null]>(`
    INSERT INTO files (slug, ext, mime, size, orig_name, storage, uploaded_at, owner_ip, upload_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getBySlug: db.prepare<FileRow, [string]>(`SELECT * FROM files WHERE slug = ?`),
  markReady: db.prepare<void, [string | null, string]>(`UPDATE files SET status = 'ready', sha256 = ? WHERE slug = ? AND status = 'pending'`),
  delete: db.prepare<void, [string]>(`DELETE FROM files WHERE slug = ?`),
  consumeUploadToken: db.prepare<void, [string]>(`UPDATE files SET upload_token = NULL WHERE slug = ?`),
  totalLocalReady: db.prepare<{ total: number }, []>(`SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE storage = 'local' AND status = 'ready'`),
  listReady: db.prepare<FileRow, [number, number]>(`SELECT * FROM files WHERE status = 'ready' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`),
  oldPending: db.prepare<FileRow, [number]>(`SELECT * FROM files WHERE status = 'pending' AND uploaded_at < ?`),
  allReadySlugs: db.prepare<{ slug: string; ext: string }, []>(`SELECT slug, ext FROM files WHERE status = 'ready' AND storage = 'local'`),
  allSupabaseReadyPaths: db.prepare<{ slug: string; ext: string }, []>(`SELECT slug, ext FROM files WHERE status = 'ready' AND storage = 'supabase'`),
};
