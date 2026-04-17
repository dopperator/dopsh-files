export type EmbedMode = 'media' | 'other';

export interface MimeEntry {
  mime: string;
  mode: EmbedMode;
}

export const MIME_MAP: Record<string, MimeEntry> = {
  // images
  png:  { mime: 'image/png',       mode: 'media' },
  jpg:  { mime: 'image/jpeg',      mode: 'media' },
  jpeg: { mime: 'image/jpeg',      mode: 'media' },
  gif:  { mime: 'image/gif',       mode: 'media' },
  webp: { mime: 'image/webp',      mode: 'media' },
  avif: { mime: 'image/avif',      mode: 'media' },
  svg:  { mime: 'image/svg+xml',   mode: 'media' },

  // video
  mp4:  { mime: 'video/mp4',       mode: 'media' },
  webm: { mime: 'video/webm',      mode: 'media' },
  mov:  { mime: 'video/quicktime', mode: 'media' },

  // audio
  mp3:  { mime: 'audio/mpeg',      mode: 'media' },
  ogg:  { mime: 'audio/ogg',       mode: 'media' },
  wav:  { mime: 'audio/wav',       mode: 'media' },
  flac: { mime: 'audio/flac',      mode: 'media' },
  opus: { mime: 'audio/opus',      mode: 'media' },
  m4a:  { mime: 'audio/mp4',       mode: 'media' },

  // documents / misc (non-media → landing page)
  pdf:  { mime: 'application/pdf',                    mode: 'other' },
  txt:  { mime: 'text/plain; charset=utf-8',          mode: 'other' },
  md:   { mime: 'text/markdown; charset=utf-8',       mode: 'other' },
  json: { mime: 'application/json',                   mode: 'other' },
  zip:  { mime: 'application/zip',                    mode: 'other' },
  tar:  { mime: 'application/x-tar',                  mode: 'other' },
  gz:   { mime: 'application/gzip',                   mode: 'other' },
  '7z': { mime: 'application/x-7z-compressed',        mode: 'other' },
  rar:  { mime: 'application/vnd.rar',                mode: 'other' },
  csv:  { mime: 'text/csv; charset=utf-8',            mode: 'other' },
};

export function extFromFilename(filename: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return m ? m[1].toLowerCase() : null;
}

export function lookupMime(ext: string): MimeEntry | null {
  return MIME_MAP[ext.toLowerCase()] ?? null;
}

export function resolveMime(ext: string): MimeEntry {
  return MIME_MAP[ext.toLowerCase()] ?? { mime: 'application/octet-stream', mode: 'other' };
}
