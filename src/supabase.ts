import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL_ = process.env.SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_KEY ?? '';
const BUCKET = process.env.SUPABASE_BUCKET ?? 'dopsh';

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

export async function createSignedUploadUrl(path: string): Promise<{ uploadUrl: string; token: string }> {
  const c = getClient();
  const { data, error } = await c.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { uploadUrl: data.signedUrl, token: data.token };
}

export function getPublicUrl(path: string): string {
  const c = getClient();
  return c.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function deleteObject(path: string): Promise<void> {
  if (!supabaseAvailable()) return;
  const c = getClient();
  const { error } = await c.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}

export async function listObjects(): Promise<string[]> {
  if (!supabaseAvailable()) return [];
  const c = getClient();
  const { data, error } = await c.storage.from(BUCKET).list('', { limit: 10_000 });
  if (error) throw error;
  return data.map(d => d.name);
}

export const SUPABASE_BUCKET = BUCKET;
