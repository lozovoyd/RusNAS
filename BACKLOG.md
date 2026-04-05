# RusNAS Backlog / Wishlist

Идеи и фичи без приоритета и сроков. Перемещаются в ROADMAP.md когда становятся актуальными.

## Идеи

- [ ] Кластеризация / HA (active-passive failover)
- [ ] S3-compatible object storage (MinIO)
- [ ] LDAP / FreeIPA интеграция вместо локальных пользователей
- [ ] Мобильное приложение (iOS/Android) для мониторинга
- [ ] Grafana dashboards интеграция (встроенный Prometheus endpoint)
- [ ] Автоматическая верификация бэкапов (restore test в sandbox)
- [ ] Двухфакторная аутентификация (TOTP) для Cockpit
- [ ] Агрегация логов (Loki / journald web viewer)
- [ ] Мониторинг температуры CPU/HDD с алертами
- [ ] Экспорт конфигурации (backup/restore настроек NAS)
- [ ] Миграция данных между массивами (online data mover)
- [ ] Поддержка шифрования томов (LUKS / dm-crypt)
- [ ] Мониторинг пропускной способности сети (iperf3 встроенный)
- [ ] Поддержка NVMe-oF (NVMe over Fabrics) для высокоскоростного iSCSI
- [ ] Кеширование метаданных Btrfs на SSD (отдельно от dm-cache)

## Технический долг

- [ ] Рефакторинг app.js (2000+ строк → разделить на модули)
- [ ] E2E тесты Playwright для всех 12 страниц Cockpit
- [ ] Python type hints для всех backend-скриптов
- [ ] Единая обёртка cockpit.spawn → Promise (устранить дублирование `new Promise(...)`)
- [ ] Единый error-handler для всех JS-модулей (сейчас каждый свой)
- [ ] Миграция CSS на CSS custom properties (вместо захардкоженных значений)
- [ ] Автоматический линтинг JS (ESLint) и Python (ruff) в pre-commit hook
- [ ] Документирование всех REST/CGI API endpoints в OpenAPI формате
- [ ] Тесты для Python backend-скриптов (pytest, сейчас покрытие ~0%)
- [ ] Оптимизация размера Cockpit plugin (tree-shake неиспользуемый CSS)
