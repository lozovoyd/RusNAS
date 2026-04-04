#!/usr/bin/env bash
# Compile ALL Python files to native code using Cython.
# Usage: ./cython-build.sh <dir>
#
# Result: ZERO .py files remain. Everything is native x86_64 code.
#
# Entry-points (with `if __name__ == "__main__"`):
#   → cython3 --embed → gcc → native ELF binary (replaces .py)
#
# Library modules (everything else):
#   → cython3 → gcc → .cpython-3XX-x86_64-linux-gnu.so
#   → original .py deleted
#
# Requires: cython3, python3-dev, gcc (Linux x86_64 only)

set -euo pipefail

DIR="${1:-.}"
SUFFIX=$(python3 -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")
PY_INCLUDES=$(python3-config --includes)
PY_LDFLAGS=$(python3-config --ldflags --embed 2>/dev/null || python3-config --ldflags)

echo "  Cython build: ${DIR}"
echo "    Python suffix: ${SUFFIX}"

COMPILED=0
ENTRIES=0
FAILED=0

find "${DIR}" -name '*.py' -not -name '__init__.py' | sort | while read -r pyfile; do
    base=$(basename "$pyfile" .py)
    pydir=$(dirname "$pyfile")

    # Skip tiny files (likely stubs/empty __init__)
    if [ "$(wc -c < "$pyfile" | tr -d ' ')" -lt 50 ]; then
        continue
    fi

    # Fix invalid module names: Cython requires valid Python identifiers
    # Hyphens in filenames (e.g. perf-collector.py) → underscores for compilation
    safe_base=$(echo "$base" | tr '-' '_')
    RENAMED=0
    if [ "$safe_base" != "$base" ]; then
        cp "$pyfile" "${pydir}/${safe_base}.py"
        RENAMED=1
    fi

    COMPILE_SRC="${pydir}/${safe_base}.py"
    [ "$RENAMED" -eq 0 ] && COMPILE_SRC="$pyfile"

    # Detect entry-point: has `if __name__` block
    IS_ENTRY=0
    grep -q '__name__.*__main__' "$COMPILE_SRC" && IS_ENTRY=1

    if [ "$IS_ENTRY" -eq 1 ]; then
        # ── Entry point → standalone binary ──────────────────────────
        echo -n "    [entry] ${base}.py → "
        cython3 -3 --embed "$COMPILE_SRC" -o "${pydir}/${safe_base}.c" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (cython)"
            rm -f "${pydir}/${safe_base}.py" "${pydir}/${safe_base}.c" 2>/dev/null
            [ "$RENAMED" -eq 1 ] && true  # keep original .py
            FAILED=$((FAILED + 1))
            continue
        fi

        gcc -O2 ${PY_INCLUDES} "${pydir}/${safe_base}.c" -o "${pydir}/${base}" ${PY_LDFLAGS} 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (gcc)"
            rm -f "${pydir}/${safe_base}.c" "${pydir}/${safe_base}.py" 2>/dev/null
            FAILED=$((FAILED + 1))
            continue
        fi

        # Output binary without .py extension
        chmod 755 "${pydir}/${base}"

        # Create a .py wrapper so `python3 script.py` still works
        # (systemd units and cockpit.spawn call `python3 /path/script.py`)
        cat > "$pyfile" << WRAPEOF
#!/usr/bin/env python3
import os,sys;os.execv(os.path.join(os.path.dirname(__file__),"${base}"),sys.argv)
WRAPEOF
        chmod 755 "$pyfile"

        rm -f "${pydir}/${safe_base}.c" "${pydir}/${safe_base}.py" 2>/dev/null
        [ "$RENAMED" -eq 1 ] && rm -f "${pydir}/${safe_base}.py" 2>/dev/null

        BIN_SIZE=$(du -sh "${pydir}/${base}" | cut -f1)
        echo "${BIN_SIZE} (ELF + .py wrapper)"
        ENTRIES=$((ENTRIES + 1))
    else
        # ── Library module → shared object (.so) ─────────────────────
        echo -n "    [lib]   ${base}.py → "
        cython3 -3 "$COMPILE_SRC" -o "${pydir}/${safe_base}.c" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (cython)"
            rm -f "${pydir}/${safe_base}.c" "${pydir}/${safe_base}.py" 2>/dev/null
            FAILED=$((FAILED + 1))
            continue
        fi

        gcc -shared -fPIC -O2 ${PY_INCLUDES} "${pydir}/${safe_base}.c" -o "${pydir}/${safe_base}${SUFFIX}" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (gcc)"
            rm -f "${pydir}/${safe_base}.c" "${pydir}/${safe_base}.py" 2>/dev/null
            FAILED=$((FAILED + 1))
            continue
        fi

        rm -f "${pydir}/${safe_base}.c" "${pydir}/${safe_base}.py" "$pyfile"

        SO_SIZE=$(du -sh "${pydir}/${safe_base}${SUFFIX}" | cut -f1)
        echo "${SO_SIZE} (.so)"
        COMPILED=$((COMPILED + 1))
    fi
done

echo "    Done: ${COMPILED} libs (.so) + ${ENTRIES} entry-points (binary), ${FAILED} failed"
