# Спецификация скилла: rusnas-docs-rebuild

## Назначение

Скилл для полной пересборки документации rusNAS:
1. Снимает свежие скриншоты всех страниц Cockpit-плагина (Playwright)
2. Обновляет скриншоты в `user-docs/docs/img/`
3. Пересобирает dev-docs (MkDocs Material + jsdoc2md + mkdocstrings)
4. Пересобирает user-docs (MkDocs Material)
5. Генерирует PDF руководство пользователя (WeasyPrint)
6. Деплоит user-docs на VM (nginx /help/)
7. Деплоит dev-docs на GitHub Pages (gh-pages ветка)

## Триггеры

Скилл запускается когда:
- Пользователь говорит: "пересобери документацию", "обнови доки", "rebuild docs"
- Пользователь говорит: "обнови скриншоты", "screenshot docs"
- Пользователь говорит: "/docs-rebuild"
- После завершения крупной фичи (если описано в CLAUDE.md правилах)

## Параметры

| Параметр | Значение по умолчанию | Описание |
|----------|----------------------|----------|
| `--screenshots` | true | Делать ли свежие скриншоты |
| `--pdf` | true | Генерировать ли PDF |
| `--deploy-vm` | true | Деплоить ли user-docs на VM |
| `--deploy-pages` | true | Деплоить ли dev-docs на GitHub Pages |
| `--dev-docs` | true | Пересобирать ли dev-docs |
| `--user-docs` | true | Пересобирать ли user-docs |

## Архитектура

### Скриншоты (Playwright)

VM: `http://10.10.10.72:9090/cockpit/@localhost/rusnas/`

Страницы для скриншотов:
1. `login` — экран Cockpit авторизации (`:9090`)
2. `dashboard` — `/rusnas/dashboard.html`
3. `storage_shares` — `/rusnas/index.html` (вкладка Шары)
4. `storage_iscsi` — `/rusnas/index.html` (вкладка iSCSI)
5. `storage_worm` — `/rusnas/index.html` (вкладка WORM)
6. `storage_services` — `/rusnas/index.html` (вкладка Сервисы)
7. `disks_raid` — `/rusnas/disks.html`
8. `users` — `/rusnas/users.html`
9. `guard` — `/rusnas/guard.html` (3 вкладки: обзор, события, настройки)
10. `snapshots` — `/rusnas/snapshots.html` (3 вкладки)
11. `dedup` — `/rusnas/dedup.html`
12. `ups` — `/rusnas/ups.html`
13. `analyzer` — `/rusnas/storage-analyzer.html` (5 вкладок)
14. `network` — `/rusnas/network.html` (4 вкладки)
15. `ai` — `/rusnas/ai.html`
16. `performance` — `/rusnas/performance.html`

Модальные окна:
17. `modal_create_share` — открыть "+ Создать" на странице шар
18. `modal_create_raid` — открыть "+ Создать массив" на странице дисков
19. `modal_create_user` — открыть "Добавить" на странице пользователей
20. `modal_ssd_cache` — открыть "Добавить SSD-кеш"
21. `subvolumes` — развернуть субтома на странице дисков

### Маппинг скриншот → markdown-страница

Описан в generate-pdf.py и в SKILL.md скилла.

### Сборка

1. `bash docs/build-docs.sh` → dev-docs (docs-site/)
2. `cd user-docs && mkdocs build -d site` → user-docs site
3. `python3 user-docs/generate-pdf.py` → PDF

### Деплой

1. VM: `./install-user-docs.sh`
2. Pages: `cd docs && mkdocs gh-deploy --force --remote-branch gh-pages`

## Зависимости

- Node.js + docx, jsdoc2md (npm)
- Python3 + mkdocs-material, mkdocstrings[python], markdown, weasyprint
- Playwright (для скриншотов)
- sshpass (для деплоя на VM)
- pango (для WeasyPrint PDF)
