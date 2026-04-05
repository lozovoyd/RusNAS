# ADR-005: Cockpit вместо собственного WebUI

## Статус
Принято (2026-01)

## Контекст
Нужен веб-интерфейс для управления NAS. Варианты: кастомный WebUI (React/Vue), Cockpit с плагинами, Webmin.

## Решение
Cockpit с кастомным плагином `rusnas`. Cockpit уже установлен на Debian, поддерживает iframe-плагины, SSH-транспорт через cockpit-bridge, авторизацию через PAM.

## Последствия
- ✅ Не нужен собственный auth/session management — PAM через cockpit-bridge
- ✅ cockpit.spawn() / cockpit.file() для взаимодействия с системой
- ✅ Авто-перезагрузка плагинов при изменении файлов
- ✅ Встроенный terminal, package updates
- ⚠️ CSP ограничения — нельзя inline onclick, нужен 'unsafe-inline' для стилей
- ⚠️ superuser: "require" вызывает timeout в iframe-контексте — workaround через sudoers
- ❌ Нет контроля над основной навигацией Cockpit Shell (только branding.css overrides)
