#!/usr/bin/env bash
# ============================================================
# RusNAS Documentation Coverage Check
# Verifies every Cockpit .html page has a matching user-docs page
# and a matching spec in docs/specs/
# Usage: bash docs/check-docs-coverage.sh
# ============================================================
cd "$(dirname "$0")/.."

ERRORS=0
WARNINGS=0

echo "╔══════════════════════════════════════════╗"
echo "║  RusNAS Docs Coverage Check              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Map cockpit page name -> user-docs directory
udocs_dir_for() {
    case "$1" in
        dashboard)          echo "dashboard" ;;
        index)              echo "storage" ;;
        disks)              echo "raid" ;;
        users)              echo "users" ;;
        guard)              echo "guard" ;;
        snapshots)          echo "snapshots" ;;
        dedup)              echo "dedup" ;;
        ups)                echo "ups" ;;
        storage-analyzer)   echo "analyzer" ;;
        network)            echo "network" ;;
        ai)                 echo "ai" ;;
        performance)        echo "performance" ;;
        containers)         echo "containers" ;;
        license)            echo "license" ;;
        notifications)      echo "_root_" ;;
        sectest)            echo "sectest" ;;
        *)                  echo "$1" ;;
    esac
}

# Map cockpit page name -> spec file
spec_for() {
    case "$1" in
        index)              echo "storage-redesign" ;;
        disks)              echo "raid-manager" ;;
        ai)                 echo "mcp-ai" ;;
        license)            echo "license-server" ;;
        users)              echo "users" ;;
        *)                  echo "$1" ;;
    esac
}

echo "▸ [1/3] Cockpit pages → user-docs..."

for htmlfile in cockpit/rusnas/*.html; do
    page=$(basename "$htmlfile" .html)
    [ "$page" = "manifest" ] && continue

    uddir=$(udocs_dir_for "$page")

    if [ "$uddir" = "_root_" ]; then
        if [ -f "user-docs/docs/${page}.md" ]; then
            echo "  ✓ $page.html → ${page}.md"
        else
            echo "  ✗ $page.html → ${page}.md MISSING"
            ERRORS=$((ERRORS + 1))
        fi
    else
        if [ -f "user-docs/docs/${uddir}/index.md" ] || ls user-docs/docs/${uddir}/*.md 1>/dev/null 2>&1; then
            echo "  ✓ $page.html → ${uddir}/"
        else
            echo "  ✗ $page.html → ${uddir}/ MISSING"
            ERRORS=$((ERRORS + 1))
        fi
    fi
done

echo ""
echo "▸ [2/3] Cockpit pages → docs/specs/..."

for htmlfile in cockpit/rusnas/*.html; do
    page=$(basename "$htmlfile" .html)
    [ "$page" = "manifest" ] && continue

    specname=$(spec_for "$page")
    if [ -f "docs/specs/${specname}.md" ] || [ -f "docs/specs/${page}.md" ]; then
        echo "  ✓ $page.html → spec found"
    else
        echo "  ⚠ $page.html → no spec"
        WARNINGS=$((WARNINGS + 1))
    fi
done

echo ""
echo "▸ [3/3] mkdocs.yml nav completeness..."

NAV_PAGES=$(grep -c '\.md' user-docs/mkdocs.yml 2>/dev/null || echo 0)
MD_FILES=$(find user-docs/docs -name "*.md" | wc -l | tr -d ' ')
echo "  Nav entries: $NAV_PAGES"
echo "  MD files:    $MD_FILES"

echo ""
echo "══════════════════════════════════════════"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo "  ✓ All checks passed!"
elif [ $ERRORS -eq 0 ]; then
    echo "  ⚠ $WARNINGS warning(s), 0 errors"
else
    echo "  ✗ $ERRORS ERROR(S), $WARNINGS warning(s)"
    echo "  Fix missing pages before merging!"
fi
echo "══════════════════════════════════════════"

exit $ERRORS
