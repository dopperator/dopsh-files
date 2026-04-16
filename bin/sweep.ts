import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { q } from '../src/db.ts';
import { FILES_DIR, localPath, partPath, removeLocal } from '../src/storage.ts';
import { deleteObject, listObjects, supabaseAvailable } from '../src/supabase.ts';

const AGE_CUTOFF_SEC = 24 * 3600;

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - AGE_CUTOFF_SEC;

  // 1) Stale pending rows → delete blobs + rows
  const stale = q.oldPending.all(cutoff);
  for (const row of stale) {
    if (row.storage === 'supabase') {
      try { await deleteObject(`${row.slug}.${row.ext}`); } catch (e) { console.warn('supabase del fail', row.slug, e); }
    } else {
      removeLocal(row.slug, row.ext);
    }
    q.delete.run(row.slug);
    console.log('swept pending', row.slug);
  }

  // 2) Local files not referenced by ready rows
  const readyLocal = new Set(q.allReadySlugs.all().map(r => `${r.slug}.${r.ext}`));
  try {
    for (const name of readdirSync(FILES_DIR)) {
      const base = name.endsWith('.part') ? name.slice(0, -5) : name;
      if (!readyLocal.has(base)) {
        try { unlinkSync(join(FILES_DIR, name)); console.log('removed orphan local', name); } catch {}
      }
    }
  } catch (e) {
    console.warn('cannot read FILES_DIR', e);
  }

  // 3) Supabase objects not referenced by ready rows
  if (supabaseAvailable()) {
    try {
      const ref = new Set(q.allSupabaseReadyPaths.all().map(r => `${r.slug}.${r.ext}`));
      for (const name of await listObjects()) {
        if (!ref.has(name)) {
          try { await deleteObject(name); console.log('removed orphan supabase', name); } catch (e) { console.warn(e); }
        }
      }
    } catch (e) {
      console.warn('supabase list/delete err', e);
    }
  }

  console.log('sweep complete');
}

main().catch(err => { console.error(err); process.exit(1); });
