import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL_ = process.env.SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_KEY ?? '';
const DEFAULT_BUCKET = process.env.SUPABASE_BUCKET ?? 'dopsh';
const MEDIA_BUCKET = process.env.SUPABASE_BUCKET_MEDIA ?? DEFAULT_BUCKET;
const FILES_BUCKET = process.env.SUPABASE_BUCKET_FILES ?? DEFAULT_BUCKET;

export function bucketFor(mode: 'media' | 'other'): string {
  return mode === 'media' ? MEDIA_BUCKET : FILES_BUCKET;
}

let client: SupabaseClient | null = null;

export function supabaseAvailable(): boolean {
  return !!(URL_ && KEY);
}

function getClient(): SupabaseClient {
  if (!client) {
    if (!supabaseAvailable()) throw new Error('Supabase not configured');
    client = createClient(URL_, KEY, { auth: { persistSession: false } });
  }
  return client;
}

export async function createSignedUploadUrl(bucket: string, path: string): Promise<{ uploadUrl: string; token: string }> {
  const c = getClient();
  const { data, error } = await c.storage.from(bucket).createSignedUploadUrl(path);
  if (error) throw error;
  return { uploadUrl: data.signedUrl, token: data.token };
}

export function getPublicUrl(bucket: string, path: string): string {
  const c = getClient();
  return c.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export async function deleteObject(bucket: string, path: string): Promise<void> {
  if (!supabaseAvailable()) return;
  const c = getClient();
  const { error } = await c.storage.from(bucket).remove([path]);
  if (error) throw error;
}

export async function listObjects(bucket: string): Promise<string[]> {
  if (!supabaseAvailable()) return [];
  const c = getClient();
  const { data, error } = await c.storage.from(bucket).list('', { limit: 10_000 });
  if (error) throw error;
  return data.map(d => d.name);
}

export const SUPABASE_BUCKET_MEDIA = MEDIA_BUCKET;
export const SUPABASE_BUCKET_FILES = FILES_BUCKET;
