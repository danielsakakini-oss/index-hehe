#!/usr/bin/env bash
# add-accents.sh
# Converts .m4a files → .mp3 (high-pass + loudness normalised),
# uploads to Cloudflare R2, and prints ready-to-paste pin URLs.
#
# Usage: ./scripts/add-accents.sh
#        ./scripts/add-accents.sh /path/to/folder   (override source dir)

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SOURCE_DIR="${1:-/Users/danielsakakini/Desktop/my website/M4As}"
BUCKET="websiteaccents"
R2_PUBLIC_URL="https://pub-ef1e11155ef34ea1896b233b05242364.r2.dev"

# Audio processing: cut below 80 Hz, normalise to -16 LUFS / -1.5 dB TP
AUDIO_FILTER="highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11"
MP3_QUALITY=2   # VBR ~190 kbps — plenty for voice

# ── Helpers ───────────────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  \033[34m→\033[0m  %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m  %s\n' "$*"; }
err()   { printf '  \033[31m✗\033[0m  %s\n' "$*" >&2; }
sep()   { printf '\033[2m%s\033[0m\n' "────────────────────────────────────────"; }

slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9 ]//g' \
    | sed 's/  */ /g' \
    | sed 's/^ //;s/ $//' \
    | sed 's/ /-/g'
}

# ── Dependency checks ─────────────────────────────────────────────────────────
if ! command -v ffmpeg &>/dev/null; then
  echo "ffmpeg not found — installing via Homebrew…"
  brew install ffmpeg
fi

if ! command -v npx &>/dev/null; then
  err "npx not found. Install Node.js and try again."
  exit 1
fi

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [[ ! -d "$SOURCE_DIR" ]]; then
  err "Source folder not found: $SOURCE_DIR"
  exit 1
fi

m4a_count=$(find "$SOURCE_DIR" -maxdepth 1 -iname "*.m4a" | wc -l | tr -d ' ')

if [[ "$m4a_count" -eq 0 ]]; then
  err "No .m4a files found in: $SOURCE_DIR"
  exit 1
fi

# ── Work directory ────────────────────────────────────────────────────────────
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ── Process each file ─────────────────────────────────────────────────────────
bold "Processing $m4a_count file(s) from: $SOURCE_DIR"
sep

uploaded_urls=()
skipped=()

while IFS= read -r m4a_file <&3; do
  filename=$(basename "$m4a_file" .m4a)
  slug=$(slugify "$filename")
  mp3_key="${slug}.mp3"
  mp3_path="${WORK_DIR}/${mp3_key}"

  bold "$filename"

  # Skip if already uploaded
  http_status=$(curl -s -o /dev/null -w "%{http_code}" --head "${R2_PUBLIC_URL}/${mp3_key}")
  if [[ "$http_status" == "200" ]]; then
    ok "Already uploaded — skipping"
    uploaded_urls+=("${R2_PUBLIC_URL}/${mp3_key}  ← $filename")
    sep
    continue
  fi

  # Convert
  info "Converting → $mp3_key"
  if ! ffmpeg -i "$m4a_file" \
      -af "$AUDIO_FILTER" \
      -codec:a libmp3lame -qscale:a "$MP3_QUALITY" \
      -y "$mp3_path" 2>/tmp/ffmpeg_err.txt; then
    err "ffmpeg failed:"
    cat /tmp/ffmpeg_err.txt >&2
    skipped+=("$filename")
    sep
    continue
  fi
  ok "Converted ($(du -sh "$mp3_path" | cut -f1))"

  # Upload to R2
  info "Uploading to R2: ${BUCKET}/${mp3_key}"
  if ! npx wrangler r2 object put "${BUCKET}/${mp3_key}" \
      --file "$mp3_path" \
      --content-type "audio/mpeg" \
      --remote 2>/tmp/wrangler_err.txt; then
    err "Upload failed:"
    cat /tmp/wrangler_err.txt >&2
    skipped+=("$filename")
    sep
    continue
  fi
  ok "Uploaded"

  public_url="${R2_PUBLIC_URL}/${mp3_key}"
  ok "URL: $public_url"
  uploaded_urls+=("$public_url  ← $filename")
  sep
done 3< <(find "$SOURCE_DIR" -maxdepth 1 -iname "*.m4a" | sort)

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
bold "Done!"
echo ""

if [[ ${#uploaded_urls[@]} -gt 0 ]]; then
  bold "Paste these R2 URLs when dropping pins in the admin UI:"
  echo ""
  for entry in "${uploaded_urls[@]}"; do
    printf '  %s\n' "$entry"
  done
  echo ""
fi

if [[ ${#skipped[@]} -gt 0 ]]; then
  bold "Skipped (errors above):"
  for f in "${skipped[@]}"; do
    printf '  • %s\n' "$f"
  done
  echo ""
fi

bold "Next steps:"
echo "  1. Go to your accent map (?admin) and log in"
echo "  2. Click '+ add an accent', drop a pin on the map"
echo "  3. Paste the URL above into the R2 audio URL field"
echo "  4. Set the accent label to the filename shown"
