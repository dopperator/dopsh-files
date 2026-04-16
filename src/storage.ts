import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { unlinkSync, renameSync } from 'node:fs';

export const SUPABASE_MAX = 50 * 1024 * 1024;                              // 50 MB (Supabase Free limit)
export const HARD_MAX     = Number(process.env.HARD_MAX ?? 2 * 1024 * 1024 * 1024); // 2 GB default
export const TOTAL_LOCAL_CAP = Number(process.env.TOTAL_LOCAL_CAP ?? 10 * 1024 * 1024 * 1024); // 10 GB
const FREE_DISK_MIN = 10 * 1024 * 1024 * 1024;                             // refuse if <10 GB free

export const FILES_DIR = resolve(process.env.FILES_DIR ?? './data/files');

export function pickStorage(size: number): 'supabase' | 'local' | null {
  if (size <= 0 || size > HARD_MAX) return null;
  return size <= SUPABASE_MAX ? 'supabase' : 'local';
}

export function localPath(slug: string, ext: string): string {
  // slug is regex-validated upstream; ext is allow-listed via MIME_MAP
  return join(FILES_DIR, `${slug}.${ext}`);
}

export function partPath(slug: string, ext: string): string {
  return `${localPath(slug, ext)}.part`;
}

export async function assertDiskAvailable(size: number): Promise<void> {
  const s = await statfs(FILES_DIR);
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < FREE_DISK_MIN) throw new Error(`disk low: only ${free} bytes free`);
  if (free < size * 1.1) throw new Error(`insufficient disk for ${size} bytes`);
}

export function finalizeLocal(slug: string, ext: string): void {
  renameSync(partPath(slug, ext), localPath(slug, ext));
}

export function removeLocal(slug: string, ext: string): void {
  try { unlinkSync(localPath(slug, ext)); } catch {}
  try { unlinkSync(partPath(slug, ext)); } catch {}
}
