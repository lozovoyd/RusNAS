#!/usr/bin/env bash
# ============================================================
# RusNAS Auto-Documentation Build Script
# Generates: JS API (jsdoc2md) + copies specs + builds MkDocs
# Usage: npm run docs  OR  bash docs/build-docs.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DOCS_SRC="docs/src"
JS_OUT="$DOCS_SRC/api/js"
PY_OUT="$DOCS_SRC/api/python"
SPECS_DIR="$DOCS_SRC/specs"
GUIDES_DIR="$DOCS_SRC/guides"
SITE_OUT="docs-site"

echo "╔══════════════════════════════════════════╗"
echo "║     RusNAS Documentation Build           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Generate JS API markdown from JSDoc ────────────────────
echo "▸ [1/5] Generating JS API docs (jsdoc2md)..."
mkdir -p "$JS_OUT"

JS_COUNT=0
JS_DOCUMENTED=0

for jsfile in cockpit/rusnas/js/*.js; do
    name=$(basename "$jsfile" .js)
    outfile="$JS_OUT/$name.md"

    # Try jsdoc2md first
    if npx jsdoc2md --no-cache "$jsfile" --configure docs/jsdoc.json > "$outfile.tmp" 2>/dev/null; then
        if [ -s "$outfile.tmp" ]; then
            mv "$outfile.tmp" "$outfile"
            JS_DOCUMENTED=$((JS_DOCUMENTED + 1))
            echo "    ✓ $name.js (JSDoc found)"
        else
            rm -f "$outfile.tmp"
        fi
    else
        rm -f "$outfile.tmp"
    fi

    # If jsdoc2md produced empty/no output — generate function index
    if [ ! -s "$outfile" ] 2>/dev/null || [ ! -f "$outfile" ]; then
        {
            echo "# $name.js"
            echo ""
            echo "> Автоматически сгенерированный индекс функций."
            echo "> JSDoc-аннотации ещё не добавлены — показан список функций с номерами строк."
            echo ""
            echo "**Файл:** \`cockpit/rusnas/js/$name.js\`  "
            lines=$(wc -l < "$jsfile" | tr -d ' ')
            echo "**Строк:** $lines"
            echo ""
            echo "## Функции"
            echo ""
            echo "| Функция | Строка |"
            echo "|---------|--------|"
            grep -n '^function ' "$jsfile" | sed 's/^\([0-9]*\):function \([^(]*\)(.*/| `\2()` | \1 |/' || true
            grep -n '^  function ' "$jsfile" | sed 's/^ *//;s/^\([0-9]*\):function \([^(]*\)(.*/| `\2()` (inner) | \1 |/' || true
            echo ""
        } > "$outfile"
        echo "    ○ $name.js (function index)"
    fi

    JS_COUNT=$((JS_COUNT + 1))
done
echo "    ($JS_DOCUMENTED/$JS_COUNT files with JSDoc)"
echo ""

# ── 1b. Add Russian headers to generated JS API pages ────────
echo "▸ [1b/5] Добавляю русские заголовки к JS API..."

add_ru_header() {
    local jsname="$1" title="$2" desc="$3"
    local outfile="$JS_OUT/$jsname.md"
    [ -f "$outfile" ] || return
    if ! head -1 "$outfile" | grep -q "^# "; then
        {
            echo "# $title"
            echo ""
            echo "> **Файл:** \`cockpit/rusnas/js/$jsname.js\`"
            echo ""
            echo "$desc"
            echo ""
            echo "---"
            echo ""
            cat "$outfile"
        } > "$outfile.tmp" && mv "$outfile.tmp" "$outfile"
    fi
}

add_ru_header ai "AI Ассистент" "Модуль интеграции с LLM (Yandex GPT / Anthropic Claude). Чат-интерфейс, MCP-прокси, инструменты управления NAS, openEYE Agent."
add_ru_header app "Хранилище (Шары)" "Управление SMB/NFS шарами, iSCSI LUN/Target, WORM, FTP/WebDAV сервисами. Единая страница с 4 вкладками."
add_ru_header containers "Контейнеры" "Менеджер контейнерных приложений (Podman). Каталог из 10 приложений, установка, мониторинг, nginx-прокси."
add_ru_header dashboard "Дашборд" "Главная страница мониторинга. Метрики CPU/RAM/Network/Disk, карточки RAID/Guard/UPS/SSD, ночной отчёт (Night Report)."
add_ru_header dedup "Дедупликация" "Управление дедупликацией через duperemove + Btrfs reflinks. Запуск, расписание, статистика экономии."
add_ru_header disks "Диски и RAID" "Полный жизненный цикл RAID-массивов (создание/удаление/монтирование), SMART-мониторинг, SSD-кеширование, Backup Mode."
add_ru_header eye "Утилиты (eye.js)" "Вспомогательные функции: escHtml, fmtBytes, fmtDate, debounce, throttle и другие утилиты общего назначения."
add_ru_header guard "Guard (Антишифровальщик)" "Клиент Guard-демона. Управление через Unix socket, PIN-авторизация, журнал событий, настройки детекторов."
add_ru_header license "Лицензирование" "Страница активации и проверки лицензии. Ed25519 подпись, связь с license server."
add_ru_header network "Сеть" "Управление сетевыми интерфейсами (ifupdown), DNS, маршрутами, диагностика (ping/traceroute/WoL), VLAN, bonding."
add_ru_header performance "Производительность" "Авто-оптимизатор дисковой подсистемы и сети. 12 уровней: VM, I/O, RAID, Btrfs, сеть, Samba, NFS, CPU."
add_ru_header snapshots "Снапшоты" "Управление Btrfs-снапшотами: список, создание, удаление, расписание, репликация на удалённый сервер."
add_ru_header storage-analyzer "Анализатор пространства" "Визуализация использования дисков: treemap, donut-chart, прогноз заполнения, анализ по пользователям и типам файлов."
add_ru_header ups "ИБП (UPS)" "Интеграция с NUT (Network UPS Tools). Мониторинг батареи, настройка авто-отключения, поддержка USB/SNMP/сетевых UPS."
add_ru_header users "Пользователи и группы" "CRUD пользователей и групп Linux. Управление через Cockpit bridge."

echo "    ✓ Русские заголовки добавлены"
echo ""

# ── 2. Symlink/copy spec files ────────────────────────────────
echo "▸ [2/5] Copying specification files..."
mkdir -p "$SPECS_DIR"

copy_spec() {
    local key="$1" src="$2"
    if [ -f "$src" ]; then
        cp "$src" "$SPECS_DIR/$key.md"
        echo "    ✓ $key.md"
    else
        echo "    ✗ $key.md (source not found: $src)"
    fi
}

copy_spec "guard"            "rusnas-guard-task.md"
copy_spec "snapshots"        "rusnas-snapshots-spec.md"
copy_spec "raid-manager"     "rusnas-RAIDmanager.md"
copy_spec "storage"          "rusnas-storage-task.md"
copy_spec "storage-analyzer" "rusnas-storage-analyzer-task.md"
copy_spec "ssd-tier"         "rusnas-ssd-tier-task.md"
copy_spec "dedup"            "rusnas-dedup-spec.md"
copy_spec "ups"              "rusnas-ups-nut_spec.md"
copy_spec "network"          "rusnas-network-task.md"
copy_spec "filebrowser"      "rusnas-filebrowser-task.md"
copy_spec "mcp-ai"           "rusnas_mcp_ai.MD"
copy_spec "performance"      "rusnas-performance-tuning-spec.md"
echo ""

# ── 3. Copy operational docs as guides ────────────────────────
echo "▸ [3/5] Copying guide sources..."
mkdir -p "$GUIDES_DIR"

[ -f "bugs.md" ]       && cp "bugs.md" "$GUIDES_DIR/known-bugs.md"       && echo "    ✓ known-bugs.md"
[ -f "webservice.md" ] && cp "webservice.md" "$GUIDES_DIR/webservices.md" && echo "    ✓ webservices.md"
[ -f "ui.md" ]         && cp "ui.md" "$GUIDES_DIR/ui-design.md"          && echo "    ✓ ui-design.md"
echo ""

# ── 4. Ensure Python API pages exist ──────────────────────────
echo "▸ [4/5] Checking Python API pages..."
mkdir -p "$PY_OUT"

for pypage in guard container-api spind network-api storage-analyzer metrics; do
    if [ ! -f "$PY_OUT/$pypage.md" ]; then
        echo "    ⚠ Missing $pypage.md — creating stub"
        echo "# $pypage" > "$PY_OUT/$pypage.md"
        echo "" >> "$PY_OUT/$pypage.md"
        echo "_Python API documentation — docstrings will be extracted automatically when available._" >> "$PY_OUT/$pypage.md"
    else
        echo "    ✓ $pypage.md"
    fi
done
echo ""

# ── 5. Build MkDocs ──────────────────────────────────────────
echo "▸ [5/5] Building MkDocs site..."
cd docs
python3 -m mkdocs build -d "../$SITE_OUT" --clean 2>&1 | grep -E "INFO|WARNING|ERROR" | head -20
cd ..

PAGES=$(find "$SITE_OUT" -name "*.html" | wc -l | tr -d ' ')
SIZE=$(du -sh "$SITE_OUT" 2>/dev/null | awk '{print $1}')

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✓ Build complete!                       ║"
echo "║  Pages: $PAGES                              ║"
echo "║  Size:  $SIZE                              ║"
echo "║  Output: $SITE_OUT/                     ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Serve locally: npm run docs:serve"
