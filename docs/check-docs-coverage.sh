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
echo "▸ [3/4] Cockpit tabs → user-docs sections..."

# Check that tabs in HTML are covered in user-docs
check_tabs() {
    local htmlfile="$1" udocs_path="$2" label="$3"
    local tabs
    tabs=$(grep -oP 'data-tab="[^"]+"' "$htmlfile" 2>/dev/null | sed 's/data-tab="//;s/"//' || true)
    [ -z "$tabs" ] && return

    local tab_count=0 doc_text=""
    if [ -f "$udocs_path" ]; then
        doc_text=$(cat "$udocs_path")
    elif [ -d "$(dirname "$udocs_path")" ]; then
        doc_text=$(cat "$(dirname "$udocs_path")"/*.md 2>/dev/null)
    fi

    for tab in $tabs; do
        tab_count=$((tab_count + 1))
    done

    if [ $tab_count -gt 0 ]; then
        echo "  $label: $tab_count tabs in HTML"
    fi
}

# Network: 6 tabs, need 6 user-docs pages
NET_TABS=$(grep -c 'advisor-tab-btn' cockpit/rusnas/network.html 2>/dev/null || echo 0)
NET_DOCS=$(ls user-docs/docs/network/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$NET_DOCS" -lt "$NET_TABS" ]; then
    echo "  ⚠ network: $NET_TABS tabs but only $NET_DOCS doc pages"
    WARNINGS=$((WARNINGS + 1))
else
    echo "  ✓ network: $NET_TABS tabs, $NET_DOCS doc pages"
fi

# Snapshots: 5 tabs
SNAP_TABS=$(grep -c 'advisor-tab-btn' cockpit/rusnas/snapshots.html 2>/dev/null || echo 0)
SNAP_DOCS=$(ls user-docs/docs/snapshots/*.md 2>/dev/null | wc -l | tr -d ' ')
SNAP_EXTRA=$(grep -c "Журнал событий\|Руководство" user-docs/docs/snapshots/manage.md 2>/dev/null || echo 0)
SNAP_TOTAL=$((SNAP_DOCS + SNAP_EXTRA))
echo "  ✓ snapshots: $SNAP_TABS tabs, $SNAP_DOCS pages (+$SNAP_EXTRA inline sections)"

# Notifications: 4 tabs
NOTIF_TABS=$(grep -c 'tab-btn' cockpit/rusnas/notifications.html 2>/dev/null || echo 0)
NOTIF_SECTIONS=$(grep -c "Каналы доставки\|Маршрутизация\|История\|Log Watcher" user-docs/docs/notifications.md 2>/dev/null || echo 0)
if [ "$NOTIF_SECTIONS" -lt "$NOTIF_TABS" ]; then
    echo "  ⚠ notifications: $NOTIF_TABS tabs but only $NOTIF_SECTIONS documented"
    WARNINGS=$((WARNINGS + 1))
else
    echo "  ✓ notifications: $NOTIF_TABS tabs, $NOTIF_SECTIONS sections"
fi

echo ""
echo "▸ [4/4] mkdocs.yml nav completeness..."

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
