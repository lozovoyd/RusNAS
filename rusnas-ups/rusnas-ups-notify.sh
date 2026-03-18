#!/bin/bash
# rusNAS UPS Notification Hook
# Called by upsmon via NOTIFYCMD
# Environment variables set by upsmon:
#   NOTIFYTYPE: ONLINE, ONBATT, LOWBATT, COMMLOST, SHUTDOWN, REPLBATT, COMMOK
#   UPSNAME: name@host

MSG="[rusNAS ИБП] ${NOTIFYTYPE}: ${UPSNAME}"

case "$NOTIFYTYPE" in
    ONBATT)   EMOJI="🟡"; DETAILS="Питание отключено. Система работает от батареи." ;;
    LOWBATT)  EMOJI="🔴"; DETAILS="Критически низкий заряд. Скоро выключение." ;;
    ONLINE)   EMOJI="🟢"; DETAILS="Питание восстановлено." ;;
    SHUTDOWN) EMOJI="🔴"; DETAILS="Инициировано выключение системы." ;;
    REPLBATT) EMOJI="🟠"; DETAILS="Требуется замена батареи ИБП." ;;
    COMMLOST) EMOJI="⚫"; DETAILS="Потеряна связь с ИБП." ;;
    COMMOK)   EMOJI="🟢"; DETAILS="Связь с ИБП восстановлена." ;;
    *)        EMOJI="ℹ️";  DETAILS="" ;;
esac

FULL_MSG="${EMOJI} ${MSG}${DETAILS:+ — $DETAILS}"

# Telegram
if [ -f /etc/rusnas/telegram.conf ]; then
    source /etc/rusnas/telegram.conf
    if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT_ID" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TG_CHAT_ID}" \
            --data-urlencode "text=${FULL_MSG}" \
            >/dev/null 2>&1 || true
    fi
fi

# Email
if command -v sendmail >/dev/null 2>&1; then
    UPS_STATUS=$(upsc "${UPSNAME}" ups.status 2>/dev/null || echo "unknown")
    CHARGE=$(upsc "${UPSNAME}" battery.charge 2>/dev/null || echo "?")
    RUNTIME=$(upsc "${UPSNAME}" battery.runtime 2>/dev/null || echo "?")
    {
        echo "To: root"
        echo "Subject: ${FULL_MSG}"
        echo ""
        echo "${FULL_MSG}"
        echo ""
        echo "Статус: ${UPS_STATUS}"
        echo "Заряд: ${CHARGE}%"
        echo "Запас хода: $((${RUNTIME:-0} / 60)) мин"
    } | sendmail -t 2>/dev/null || true
fi

# syslog
logger -t rusnas-ups "${FULL_MSG}"

exit 0
