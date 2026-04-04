#!/usr/bin/env bash
# Compile all Python files in a directory tree to .so using Cython.
# Usage: ./cython-build.sh <dir>
# Requires: cython3, python3-dev, gcc (on the build machine — must be Linux x86_64)
#
# For each .py file:
#   1. Cython compiles .py → .c
#   2. gcc compiles .c → .cpython-3XX-x86_64-linux-gnu.so
#   3. Original .py replaced with stub loader
#   4. .c file removed
#
# Entry-point scripts (with shebang #!/usr/bin/env python3) get a stub that
# imports the compiled module and calls main() if it exists.

set -euo pipefail

DIR="${1:-.}"
SUFFIX=$(python3 -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")
INCLUDES=$(python3-config --includes)

echo "Cython build: ${DIR}"
echo "  Python suffix: ${SUFFIX}"
echo ""

COUNT=0
SKIP=0

find "${DIR}" -name '*.py' -not -name '__init__.py' | sort | while read -r pyfile; do
    base=$(basename "$pyfile" .py)
    pydir=$(dirname "$pyfile")
    sofile="${pydir}/${base}${SUFFIX}"

    # Skip __init__.py and very small files (likely stubs)
    if [ "$(wc -c < "$pyfile" | tr -d ' ')" -lt 50 ]; then
        echo "  skip: ${pyfile} (too small)"
        SKIP=$((SKIP + 1))
        continue
    fi

    echo -n "  compile: ${pyfile} → "

    # Step 1: Cython .py → .c
    cython3 -3 "$pyfile" -o "${pydir}/${base}.c" 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "FAILED (cython)"
        continue
    fi

    # Step 2: gcc .c → .so
    gcc -shared -fPIC -O2 ${INCLUDES} \
        "${pydir}/${base}.c" -o "$sofile" 2>/dev/null
    if [ $? -ne 0 ]; then
        echo "FAILED (gcc)"
        rm -f "${pydir}/${base}.c"
        continue
    fi

    # Step 3: Check if this is an entry-point script (has `if __name__ == "__main__"`)
    IS_ENTRY=0
    grep -q '__name__.*__main__' "$pyfile" && IS_ENTRY=1

    # Step 4: Entry points stay as stripped .py; libraries become .so
    if [ "$IS_ENTRY" -eq 1 ]; then
        # Entry point: Cython can't handle __main__ block on import.
        # Keep as stripped .py — it's thin (just imports + main call).
        echo "  (entry point — keeping as stripped .py)"
        rm -f "$sofile" "${pydir}/${base}.c" 2>/dev/null
        SKIP=$((SKIP + 1))
        continue
        chmod 755 "$pyfile"
    else
        # Library module: minimal stub for fallback imports
        cat > "$pyfile" << STUBEOF
from ${base} import *
STUBEOF
    fi

    # Cleanup
    rm -f "${pydir}/${base}.c"

    SO_SIZE=$(du -sh "$sofile" | cut -f1)
    echo "${SO_SIZE} (${base}${SUFFIX})"
    COUNT=$((COUNT + 1))
done

echo ""
echo "Done: ${COUNT} files compiled"
