#!/bin/bash
# rusNAS deduplication wrapper
# Управляется через Cockpit — не редактировать вручную

CONFIG="/etc/rusnas/dedup-config.json"
STATE_DIR="/var/lib/rusnas"
LOG="/var/log/rusnas/dedup.log"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"

# Проверяем наличие duperemove
if ! command -v duperemove &>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: duperemove not found. Install: apt install duperemove" >> "$LOG"
    exit 1
fi

# Читаем конфиг
if [ ! -f "$CONFIG" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] No config at $CONFIG, exiting." >> "$LOG"
    exit 0
fi

VOLUMES=$(python3 -c "
import json, sys
try:
    c = json.load(open('$CONFIG'))
    print(' '.join(c.get('volumes', [])))
except Exception as e:
    sys.stderr.write(str(e) + '\n')
" 2>>"$LOG")

DEDUP_ARGS=$(python3 -c "
import json, sys
try:
    c = json.load(open('$CONFIG'))
    print(c.get('duperemove_args', '--dedupe-options=block'))
except Exception as e:
    sys.stderr.write(str(e) + '\n')
    print('--dedupe-options=block')
" 2>>"$LOG")

if [ -z "$VOLUMES" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] No volumes configured, exiting." >> "$LOG"
    exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] === rusNAS Deduplication started ===" >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Volumes: $VOLUMES" >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Args: $DEDUP_ARGS" >> "$LOG"

START_TS=$(date +%s)
TOTAL_SAVED=0
TOTAL_FILES=0
STATUS="success"
ERROR_MSG=""

for VOL in $VOLUMES; do
    if [ ! -d "$VOL" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: volume $VOL not mounted, skipping." >> "$LOG"
        continue
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting duperemove on $VOL" >> "$LOG"

    DB_PATH="$STATE_DIR/dedup-${VOL//\//-}.db"

    OUTPUT=$(duperemove -r -d -h "$DB_PATH" $DEDUP_ARGS "$VOL" 2>&1)
    EXIT_CODE=$?

    echo "$OUTPUT" >> "$LOG"

    if [ $EXIT_CODE -ne 0 ]; then
        STATUS="error"
        ERROR_MSG="duperemove exited with code $EXIT_CODE on $VOL"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $ERROR_MSG" >> "$LOG"
    fi

    # Парсим вывод duperemove: количество файлов
    FILES=$(echo "$OUTPUT" | grep -oP 'Total files:\s+\K[0-9]+' | head -1)
    FILES=${FILES:-0}
    TOTAL_FILES=$((TOTAL_FILES + FILES))

    # Реальная экономия = total shared extents на томе (reflinks + duperemove + snapshots)
    # btrfs filesystem du -s выводит: Total | Exclusive | Set shared | Path
    SHARED=$(btrfs filesystem du -s "$VOL" 2>/dev/null | tail -1 | awk '{print $3}')
    SHARED_BYTES=$(python3 -c "
import re, sys
s = '$SHARED'.strip()
if not s or s == '0.00B':
    print(0)
    sys.exit()
m = re.match(r'([\d.]+)\s*([KMGT]?i?B?)', s)
if m:
    val = float(m.group(1))
    unit = m.group(2).upper().replace('IB','').replace('B','')
    mult = {'': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776}
    print(int(val * mult.get(unit, 1)))
else:
    print(0)
" 2>/dev/null || echo 0)
    SHARED_BYTES=${SHARED_BYTES:-0}
    TOTAL_SAVED=$((TOTAL_SAVED + SHARED_BYTES))

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $VOL: shared=${SHARED_BYTES} bytes (${SHARED}), files=${FILES}" >> "$LOG"
done

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

# Пишем состояние
python3 - <<PYEOF
import json, time, os

state_dir = "$STATE_DIR"
os.makedirs(state_dir, exist_ok=True)

state = {
    "last_run_ts": $END_TS,
    "status": "$STATUS",
    "duration_sec": $DURATION,
    "files_scanned": $TOTAL_FILES,
    "extents_merged": 0,
    "saved_bytes": $TOTAL_SAVED,
    "error_msg": "$ERROR_MSG"
}
last_path = state_dir + "/dedup-last.json"
with open(last_path, "w") as f:
    json.dump(state, f)
os.chmod(last_path, 0o644)

# Обновляем историю (7 записей)
history_path = state_dir + "/dedup-history.json"
try:
    history = json.load(open(history_path))
except:
    history = []

today = time.strftime("%Y-%m-%d")
existing = next((i for i, e in enumerate(history) if e.get("date") == today), None)
entry = {"date": today, "saved_bytes": $TOTAL_SAVED}
if existing is not None:
    history[existing] = entry
else:
    history.insert(0, entry)
history = history[:7]

with open(history_path, "w") as f:
    json.dump(history, f)
os.chmod(history_path, 0o644)
PYEOF

echo "[$(date '+%Y-%m-%d %H:%M:%S')] === Done. Saved: $TOTAL_SAVED bytes, Files: $TOTAL_FILES, Duration: ${DURATION}s ===" >> "$LOG"
