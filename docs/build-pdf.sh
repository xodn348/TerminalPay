#!/usr/bin/env bash
# Build pitch.pdf from pitch.html using headless Chrome.
# Run from repo root:  bash docs/build-pdf.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HTML="$HERE/pitch.html"
PDF="$HERE/pitch.pdf"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at $CHROME" >&2
  echo "Install Google Chrome or edit CHROME path in this script." >&2
  exit 1
fi

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf-no-header \
  --print-to-pdf="$PDF" \
  "file://$HTML" >/dev/null 2>&1

echo "wrote $PDF ($(du -h "$PDF" | cut -f1))"
