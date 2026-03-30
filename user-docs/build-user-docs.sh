#!/usr/bin/env bash
# ============================================================
# RusNAS User Documentation Build
# Generates static HTML site for end-user documentation
# Served from NAS at https://<IP>/help/
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

SITE_OUT="site"

echo "╔══════════════════════════════════════════╗"
echo "║  RusNAS — Сборка документации            ║"
echo "║  для пользователей                       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "▸ Сборка MkDocs..."
python3 -m mkdocs build -d "$SITE_OUT" --clean 2>&1 | grep -E "INFO|WARNING|ERROR" | head -10

PAGES=$(find "$SITE_OUT" -name "*.html" | wc -l | tr -d ' ')
SIZE=$(du -sh "$SITE_OUT" 2>/dev/null | awk '{print $1}')

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✓ Готово!                               ║"
echo "║  Страниц: $PAGES                            ║"
echo "║  Размер:  $SIZE                            ║"
echo "║  Каталог: user-docs/$SITE_OUT/           ║"
echo "╚══════════════════════════════════════════╝"
