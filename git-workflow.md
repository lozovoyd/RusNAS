# rusNAS — Git Workflow

> Используется в проекте. Обновлять при изменении стратегии веток или правил коммитов.

## Стратегия: Feature Branch Flow

```
main              ──●────────────●────────────●──  ← production
                                 ↑            ↑
feature/dashboard  ──●──●──●────┘            │
feature/replication         ──●──●──●────────┘
hotfix/bug-name                     ──●──────┘
```

## Правила веток

| Ветка | Назначение | Создаётся от | Вливается в |
|-------|-----------|-------------|------------|
| `main` | Production. То что деплоено на VM | — | — |
| `feature/<name>` | Новая фича | `main` | `main` (merge --no-ff) |
| `hotfix/<name>` | Срочный баг в production | `main` | `main` (прямой commit) |

**`main` всегда = задеплоенный код.** После merge → сразу `./deploy.sh`.

## Команды

### Начать новую фичу
```bash
git checkout main
git pull origin main
git checkout -b feature/my-feature
git push -u origin feature/my-feature
```

### Влить фичу в main
```bash
git checkout main
git merge feature/my-feature --no-ff
git push origin main
./deploy.sh
```

### Если main обновился пока работаешь над фичей
```bash
git checkout feature/my-feature
git rebase main
# при конфликтах: исправить → git add → git rebase --continue
git push origin feature/my-feature --force-with-lease
```

## Баг-фиксы

- **Срочный**: коммит прямо в `main` → `./deploy.sh`
- **В рамках текущей фичи**: коммит в feature-ветку как обычно
- **Нужен в нескольких ветках**: `git cherry-pick <commit-hash>`

## Правила коммитов

Формат: `тип: краткое описание`

| Тип | Когда |
|-----|-------|
| `feat:` | Новая функциональность |
| `fix:` | Исправление бага |
| `docs:` | Только документация |
| `refactor:` | Рефактор без изменения поведения |

Всегда добавлять в конец:
```
Authored-By: Dmitrii V. Lozovoi (lozovoyd@gmail.com)
```

## Текущие ветки

- `main` — стабильная production, задеплоена на VM
- `feature/mcp-ai` — текущая активная ветка (AI, RAID upgrades, stale resources)
- `feature/dashboard` — слита в main (2026-03-15)
- `feature/dedup` — слита в main (2026-03-15)
- `feature/network` — слита в main (2026-03-22)
