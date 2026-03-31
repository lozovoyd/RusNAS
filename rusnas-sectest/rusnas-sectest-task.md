# rusNAS Security Self-Test (sectest) — ТЗ и архитектура

## Назначение

Автоматизированный пентест сборки rusNAS, запускаемый на самой VM. Проверяет все сервисы по OWASP Top 10 с использованием nmap, nuclei, ffuf, sqlmap, curl, python3.

## Два режима работы

1. **Автоматический (monthly)** — systemd timer, 1-е число каждого месяца в 04:00
2. **Ручной** — кнопка "Проверить сейчас" на Dashboard или CLI

## Архитектура

```
sectest.py (оркестратор)
  ├── checks/recon.py          — nmap port scan, service detection
  ├── checks/web_headers.py    — TLS, HTTP headers, HSTS, CSP, cookies
  ├── checks/access_control.py — NFS, SMB, rsync, FTP, forced browsing, FileBrowser scope
  ├── checks/auth.py           — default creds, JWT analysis, rate limiting
  ├── checks/injection.py      — SQLi (sqlmap), XSS, SSTI, cmd injection
  ├── checks/misconfig.py      — directory listing, TRACE, CORS, versions
  ├── checks/vuln_scan.py      — nuclei CVE + misconfig (skip --quick)
  ├── checks/endpoint_fuzz.py  — ffuf discovery (skip --quick)
  └── checks/network_services.py — SMB signing, rpcbind, Samba config
```

## ID-диапазоны проверок

| Range | Module | Phase |
|-------|--------|-------|
| SEC-100..199 | recon.py | Reconnaissance |
| SEC-200..299 | web_headers.py | Web Security |
| SEC-300..399 | access_control.py | Access Control |
| SEC-400..499 | auth.py | Authentication |
| SEC-500..599 | injection.py | Injection |
| SEC-600..699 | misconfig.py | Misconfiguration |
| SEC-700..799 | vuln_scan.py | Vulnerability Scan |
| SEC-800..899 | endpoint_fuzz.py | Endpoint Fuzzing |
| SEC-900..999 | network_services.py | Network Services |

## Файлы на VM

| Путь | Описание |
|------|----------|
| `/usr/lib/rusnas/sectest/sectest.py` | Основной скрипт |
| `/usr/lib/rusnas/sectest/checks/*.py` | Модули проверок |
| `/usr/lib/rusnas/sectest/wordlists/rusnas-paths.txt` | Wordlist для ffuf |
| `/var/lib/rusnas/sectest-last.json` | Последний результат (читается dashboard) |
| `/var/lib/rusnas/sectest-report.md` | Markdown-отчёт |
| `/var/log/rusnas/sectest.log` | Лог всех прогонов |
| `/lib/systemd/system/rusnas-sectest.service` | systemd oneshot |
| `/lib/systemd/system/rusnas-sectest.timer` | Monthly timer |

## CLI

```bash
python3 sectest.py                    # Полный пентест
python3 sectest.py --quick            # Быстрый (без nuclei/sqlmap/ffuf)
python3 sectest.py --json             # JSON output
python3 sectest.py --category web     # Только веб
python3 sectest.py --category network # Только сеть
python3 sectest.py --category auth    # Только аутентификация
```

## Scoring

Start 100, penalty per fail: critical -20, high -10, medium -5, low -2. Min 0.
Grade: A (90+), B (75+), C (60+), D (40+), F (<40).

## Dashboard интеграция

- Карточка "🔒 БЕЗОПАСНОСТЬ" в grid-4 секции
- Alert banner при critical/high findings
- Кнопка "Проверить сейчас" запускает --quick --json
- Кнопка "Отчёт" открывает sectest-report.md
- Polling: каждые 60 сек читает sectest-last.json

## Зависимости (инструменты)

Обязательные: python3, curl, openssl
Рекомендуемые: nmap, smbclient, showmount
Опциональные (полный scan): nuclei, ffuf, sqlmap

install-sectest.sh устанавливает все инструменты автоматически.

## Реализовано: Session 2026-03-31

- sectest.py + 9 модулей проверок (47 проверок в quick mode)
- install-sectest.sh (deploy + tool install)
- Dashboard карточка + alert banner
- systemd monthly timer
- README.md
