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

    # Detect entry-point: has `if __name__` block
    IS_ENTRY=0
    grep -q '__name__.*__main__' "$pyfile" && IS_ENTRY=1

    if [ "$IS_ENTRY" -eq 1 ]; then
        # ── Entry point → standalone binary ──────────────────────────
        echo -n "    [entry] ${base}.py → "
        cython3 -3 --embed "$pyfile" -o "${pydir}/${base}.c" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (cython)"
            FAILED=$((FAILED + 1))
            continue
        fi

        gcc -O2 ${PY_INCLUDES} "${pydir}/${base}.c" -o "${pydir}/${base}" ${PY_LDFLAGS} 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (gcc)"
            rm -f "${pydir}/${base}.c"
            FAILED=$((FAILED + 1))
            continue
        fi

        chmod 755 "${pydir}/${base}"
        rm -f "${pydir}/${base}.c" "$pyfile"

        BIN_SIZE=$(du -sh "${pydir}/${base}" | cut -f1)
        echo "${BIN_SIZE} (ELF binary)"
        ENTRIES=$((ENTRIES + 1))
    else
        # ── Library module → shared object (.so) ─────────────────────
        echo -n "    [lib]   ${base}.py → "
        cython3 -3 "$pyfile" -o "${pydir}/${base}.c" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (cython)"
            FAILED=$((FAILED + 1))
            continue
        fi

        gcc -shared -fPIC -O2 ${PY_INCLUDES} "${pydir}/${base}.c" -o "${pydir}/${base}${SUFFIX}" 2>/dev/null
        if [ $? -ne 0 ]; then
            echo "FAILED (gcc)"
            rm -f "${pydir}/${base}.c"
            FAILED=$((FAILED + 1))
            continue
        fi

        rm -f "${pydir}/${base}.c" "$pyfile"

        SO_SIZE=$(du -sh "${pydir}/${base}${SUFFIX}" | cut -f1)
        echo "${SO_SIZE} (.so)"
        COMPILED=$((COMPILED + 1))
    fi
done

echo "    Done: ${COMPILED} libs (.so) + ${ENTRIES} entry-points (binary), ${FAILED} failed"
