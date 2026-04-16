# dop.sh file service

Small Bun HTTP server powering `https://dop.sh/u/...` and `/api/upload/*`.

## Tiers

| Size | Storage |
|---|---|
| ≤ 50 MB | Supabase Storage (Free plan) |
| > 50 MB and ≤ `HARD_MAX` (default 2 GB) | Local disk at `data/files/` |

## Upload (two-step)

**Step 1 — init:**

```bash
curl -X POST https://dop.sh/api/upload/init \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"clip.mp4","size":123456789,"mime":"video/mp4"}'
```

Response:

```json
{
  "slug": "aB3xK9q",
  "storage": "local",          // or "supabase"
  "viewUrl":  "https://dop.sh/u/aB3xK9q.mp4",
  "streamUrl":"https://dop.sh/api/upload/stream/aB3xK9q",  // local tier
  "uploadUrl":"https://...supabase.co/...",                // supabase tier
  "uploadToken":"..."
}
```

**Step 2a — local tier:**

```bash
curl -X PUT "$streamUrl" \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "X-Upload-Token: $uploadToken" \
  --data-binary @clip.mp4
```

**Step 2b — supabase tier:**

```bash
curl -X PUT "$uploadUrl" --data-binary @pic.png
curl -X POST https://dop.sh/api/upload/complete \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"aB3xK9q"}'
```

Then share `viewUrl`.

## Shell helper (`dopup`)

```bash
dopup() {
  local f="$1" size mime name init slug storage up_url stream up_tok
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  mime=$(file -b --mime-type "$f" 2>/dev/null || echo application/octet-stream)
  name=$(basename "$f")
  init=$(curl -sS -X POST https://dop.sh/api/upload/init \
    -H "Authorization: Bearer $DOPSH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg f "$name" --argjson s "$size" --arg m "$mime" '{filename:$f,size:$s,mime:$m}')")
  storage=$(echo "$init" | jq -r .storage)
  slug=$(echo "$init" | jq -r .slug)
  up_tok=$(echo "$init" | jq -r .uploadToken)
  if [ "$storage" = "local" ]; then
    stream=$(echo "$init" | jq -r .streamUrl)
    curl -sS -X PUT "$stream" \
      -H "Authorization: Bearer $DOPSH_TOKEN" \
      -H "X-Upload-Token: $up_tok" \
      --data-binary "@$f" > /dev/null
  else
    up_url=$(echo "$init" | jq -r .uploadUrl)
    curl -sS -X PUT "$up_url" --data-binary "@$f" > /dev/null
    curl -sS -X POST https://dop.sh/api/upload/complete \
      -H "Authorization: Bearer $DOPSH_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"slug\":\"$slug\"}" > /dev/null
  fi
  echo "$init" | jq -r .viewUrl
}
```

Set `DOPSH_TOKEN` in your shell profile to the server's `UPLOAD_TOKEN`.

## Env vars

See `.env.example`. Leave Supabase vars blank to disable that tier.

## Processes

Runs under pm2 as `dopsh-files`. Restart with `sudo pm2 restart dopsh-files` (allowed by `/etc/sudoers.d/dopsh-files-pm2`).

## Sweeper

`bun run sweep` deletes stale pending rows (>24 h) and orphaned blobs. A systemd timer runs this daily.
