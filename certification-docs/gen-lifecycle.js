#!/usr/bin/env node
/**
 * Генератор: Описание процессов поддержания жизненного цикла ПО rusNAS
 * ГОСТ 19.101-77, ГОСТ Р ИСО/МЭК 12207
 * Output: certification-docs/RusNAS_Жизненный_цикл.docx
 */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, LevelFormat,
  BorderStyle, WidthType, ShadingType, PageNumber, PageBreak
} = require('docx');

const OUT = path.join(__dirname, 'RusNAS_Жизненный_цикл.docx');

// ── Helpers ──
const font = 'Times New Roman';
const sz = 24; // 12pt
const szSmall = 20; // 10pt

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, font, size: 28, bold: true })]
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, font, size: 26, bold: true })]
  });
}
function p(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60, line: 360 },
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
    indent: opts.noIndent ? undefined : { firstLine: 709 }, // 1.25cm paragraph indent
    children: [new TextRun({ text, font, size: sz, ...(opts.bold ? { bold: true } : {}), ...(opts.italic ? { italics: true } : {}) })]
  });
}
function bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { before: 40, after: 40, line: 360 },
    children: [new TextRun({ text, font, size: sz })]
  });
}
function numbered(text) {
  return new Paragraph({
    numbering: { reference: 'numbers', level: 0 },
    spacing: { before: 40, after: 40, line: 360 },
    children: [new TextRun({ text, font, size: sz })]
  });
}
function emptyLine() {
  return new Paragraph({ spacing: { before: 120 }, children: [] });
}

const border = { style: BorderStyle.SINGLE, size: 1, color: '000000' };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, opts = {}) {
  return new TableCell({
    borders,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.header ? { fill: 'E8E8E8', type: ShadingType.CLEAR } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text, font, size: szSmall, bold: !!opts.header })]
    })]
  });
}

// ── Document content ──
const children = [];

// Title page
children.push(new Paragraph({ spacing: { before: 2000 }, children: [] }));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 200 },
  children: [new TextRun({ text: 'ООО «Техномакс-Красноярск»', font, size: 28, bold: true })]
}));
children.push(emptyLine());
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 100 },
  children: [new TextRun({ text: 'Сетевое хранилище данных корпоративного класса', font, size: sz, color: '666666' })]
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { after: 400 },
  children: [new TextRun({ text: '«rusNAS»', font, size: 36, bold: true })]
}));
children.push(emptyLine());
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 400, after: 200 },
  children: [new TextRun({ text: 'ОПИСАНИЕ ПРОЦЕССОВ, ОБЕСПЕЧИВАЮЩИХ\nПОДДЕРЖАНИЕ ЖИЗНЕННОГО ЦИКЛА', font, size: 30, bold: true })]
}));
children.push(emptyLine());
children.push(new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 2000 },
  children: [new TextRun({ text: 'Красноярск, 2026', font, size: sz })]
}));
children.push(new Paragraph({ children: [new PageBreak()] }));

// ── 1. О программном продукте ──
children.push(h1('1. О ПРОГРАММНОМ ПРОДУКТЕ'));

children.push(p('Программный комплекс «rusNAS» (далее — ПК, Продукт) представляет собой сетевое хранилище данных корпоративного класса, разработанное как полнофункциональная альтернатива Synology DSM для сегмента малого и среднего бизнеса.'));

children.push(p('Продукт устанавливается на выделенное серверное оборудование под управлением операционной системы Debian 13 (Trixie), архитектура x86_64. Управление осуществляется через веб-интерфейс на базе Cockpit с собственным плагином rusNAS, доступным по HTTPS (порт 9090).'));

children.push(p('Системные требования к серверному оборудованию:'));
children.push(bullet('Процессор: x86_64, 2 ядра и более (рекомендуется 4+)'));
children.push(bullet('Оперативная память: от 4 ГБ (рекомендуется 8 ГБ и более)'));
children.push(bullet('Системный диск: от 32 ГБ (SSD рекомендуется)'));
children.push(bullet('Диски для данных: от 2 шт. (для RAID-массивов)'));
children.push(bullet('Сетевой адаптер: Ethernet 1 Гбит/с и выше'));
children.push(bullet('Поддерживаемые ОС: Debian 13 Trixie (штатная), совместимость с Debian 12'));

children.push(p('Клиентский доступ к хранилищу поддерживается по протоколам: SMB/CIFS (Windows, macOS, Linux), NFS (Linux, macOS), FTP/FTPS, WebDAV, iSCSI. Веб-интерфейс управления совместим с браузерами Chrome, Firefox, Edge, Safari актуальных версий.'));

children.push(p('Основные функциональные модули:'));
children.push(bullet('Управление RAID-массивами (mdadm): уровни 0, 1, 5, 6, 10'));
children.push(bullet('Файловая система Btrfs: снапшоты, субтома, дедупликация, WORM'));
children.push(bullet('Общие папки: SMB/NFS с унифицированным интерфейсом'));
children.push(bullet('Guard (антишифровальщик): 4 метода детекции, 3 режима реагирования'));
children.push(bullet('Снапшоты: ручные/автоматические, расписание, репликация на удалённый сервер'));
children.push(bullet('Дедупликация: duperemove + Btrfs reflinks'));
children.push(bullet('ИБП: интеграция с NUT (Network UPS Tools)'));
children.push(bullet('Анализатор пространства: treemap, прогноз заполнения, статистика'));
children.push(bullet('Сеть: настройка интерфейсов, DNS, маршруты, VLAN, bonding, диагностика'));
children.push(bullet('SSD-кеширование: LVM dm-cache (writethrough/writeback)'));
children.push(bullet('Производительность: авто-оптимизатор (12 уровней настройки)'));
children.push(bullet('AI-ассистент: интеграция с Yandex GPT / Anthropic Claude'));
children.push(bullet('Контейнеры: Podman-based каталог из 10 приложений'));
children.push(bullet('Лицензирование: Ed25519 подпись, license server, bootstrap installer'));

// ── 2. Поддержание жизненного цикла ──
children.push(h1('2. ПОДДЕРЖАНИЕ ЖИЗНЕННОГО ЦИКЛА ПРОГРАММНОГО ПРОДУКТА'));

children.push(p('Поддержание жизненного цикла, доработка и техническая поддержка ПК «rusNAS» осуществляется сотрудниками ООО «Техномакс-Красноярск» (ИНН: 2460248300, ОГРН: 1132468044653, адрес: 660018, Красноярский край, г. Красноярск, ул. Новосибирская, д. 42) в течение всего периода эксплуатации программного продукта.'));

children.push(p('ООО «Техномакс-Красноярск» является ответственным за обновление и поддержку программного продукта, которые включают в себя:'));

children.push(numbered('Решение вопросов пользователей программного продукта через каналы технической поддержки (электронная почта, телефон, онлайн-документация).'));
children.push(numbered('Размещение и актуализация технической документации: пользовательское руководство доступно онлайн на устройстве (https://<IP>/help/), разработческая документация — на GitHub Pages (https://lozovoyd.github.io/RusNAS/). Документация автоматически пересобирается при каждом обновлении кодовой базы.'));
children.push(numbered('Выпуск новых версий программного продукта с доставкой обновлений через собственный apt-репозиторий (https://activate.rusnas.ru/apt/). Устройства получают обновления автоматически через штатный механизм apt upgrade.'));
children.push(numbered('Устранение неисправностей (дефектов), выявленных в ходе эксплуатации программного обеспечения. Все обнаруженные и исправленные дефекты документируются в файле bugs.md с присвоением уникального номера (BUG-NN). На момент выпуска версии 1.0 задокументировано и исправлено 30 дефектов.'));
children.push(numbered('Обеспечение совместимости с обновлениями операционной системы Debian, системных компонентов (mdadm, Btrfs, Samba, NFS, NUT) и зависимостей.'));
children.push(numbered('Совершенствование программного продукта на основании запросов пользователей и требований рынка, включая разработку новых модулей и расширение функциональности существующих.'));

// ── 2.1. Модель жизненного цикла ──
children.push(h2('2.1. Модель жизненного цикла'));

children.push(p('Жизненный цикл ПК «rusNAS» организован в соответствии с итеративно-инкрементальной моделью разработки и включает следующие стадии:'));

children.push(p('Стадия 1. Формирование требований — сбор и анализ потребностей целевых пользователей (системные администраторы, IT-отделы SMB), формирование технического задания на каждый модуль в виде отдельного документа (rusnas-*-task.md). На данный момент создано 18 спецификаций модулей.', { bold: false }));

children.push(p('Стадия 2. Проектирование — разработка архитектуры системы с учётом ключевых ограничений: Btrfs + mdadm (не ZFS) из-за требования онлайн-миграции RAID-уровней, Cockpit как UI-платформа (не отдельный фреймворк), Ansible для провижининга. Проектные решения фиксируются в CLAUDE.md и roadmap.md.'));

children.push(p('Стадия 3. Кодирование — реализация модулей в соответствии с установленными паттернами разработки: JS ES5 для Cockpit-плагина (15 файлов), Python 3 для backend-сервисов (9 файлов), bash для скриптов деплоя и установки (12 файлов). Код снабжается JSDoc (JS) и Google-style docstrings (Python).'));

children.push(p('Стадия 4. Тестирование — верификация на реальном оборудовании (VM Debian 13 / QEMU), регрессионное тестирование после каждого изменения, автоматические тесты (15 тестов Backup Mode UI, 22 теста License Server). Тестирование охватывает все поддерживаемые протоколы и сценарии отказов.'));

children.push(p('Стадия 5. Ввод в действие — деплой через механизм apt-пакетов на целевые устройства. Bootstrap-установщик (bootstrap.sh) автоматизирует первоначальную настройку: установку пакетов, активацию лицензии, конфигурацию системы.'));

children.push(p('Стадия 6. Эксплуатация и сопровождение — непрерывный мониторинг, выпуск обновлений, техническая поддержка. История всех сессий разработки ведётся в project_history.md (только дополнение, без перезаписи).'));

// ── 2.2. Управление версиями ──
children.push(h2('2.2. Управление версиями и конфигурациями'));

children.push(p('Исходный код ПК «rusNAS» хранится в системе контроля версий Git (репозиторий GitHub). Применяется стратегия Feature Branch Flow:'));
children.push(bullet('Ветка main — стабильный, задеплоенный код'));
children.push(bullet('Ветки feat/* — разработка новых функций (одна ветка на фичу)'));
children.push(bullet('Формат коммитов: feat:|fix:|docs:|refactor: + описание'));
children.push(bullet('Merge в main только после верификации на тестовой VM'));
children.push(bullet('После каждого merge — обязательное обновление документации (project_history.md, bugs.md, roadmap.md, CLAUDE.md)'));

children.push(p('Конфигурация инфраструктуры (Ansible monorepo) также версионируется в Git. Конфигурационные файлы на устройствах управляются атомарно через cockpit.file().replace() с транзакционной записью (tempfile + rename).'));

// ── 2.3. Обновление ──
children.push(h2('2.3. Механизм обновления'));

children.push(p('Обновление ПК «rusNAS» на устройствах пользователей осуществляется через собственный apt-репозиторий:'));
children.push(bullet('URL репозитория: https://activate.rusnas.ru/apt/'));
children.push(bullet('Подпись пакетов: GPG-ключ, добавляемый при установке'));
children.push(bullet('Доставка: штатный механизм apt upgrade'));
children.push(bullet('Обновление Cockpit-плагина: автоматическая перезагрузка при обновлении файлов (без перезапуска сервисов)'));
children.push(bullet('Обновление backend-сервисов: systemd restart по мере необходимости'));

children.push(p('Процесс обновления спроектирован с минимальным временем простоя: Cockpit-плагин обновляется без разрыва текущих SMB/NFS-сессий, backend-сервисы перезапускаются поочерёдно.'));

// ── 2.4. Резервное копирование ──
children.push(h2('2.4. Резервное копирование и восстановление'));

children.push(p('Продукт включает встроенные механизмы защиты данных:'));
children.push(bullet('Btrfs-снапшоты: ручное и автоматическое (по расписанию, systemd timer каждые 5 минут)'));
children.push(bullet('Репликация снапшотов: btrfs send | ssh на удалённый сервер (инкрементальная)'));
children.push(bullet('Apt-снапшот перед обновлением: hook 99rusnas-snapshot создаёт снапшот «pre-update-all» до apt upgrade'));
children.push(bullet('Guard: автоматический снапшот всех томов при обнаружении атаки шифровальщика'));
children.push(bullet('WORM-защита: WriteOnce-пути для критичных данных (защита от удаления)'));
children.push(bullet('Конфигурации: все настройки модулей хранятся в JSON-файлах в /etc/rusnas/, резервируются вместе с системным бэкапом'));

children.push(p('Восстановление после сбоя: при потере данных администратор использует интерфейс снапшотов для выбора точки восстановления. Btrfs-снапшоты позволяют восстановить отдельные файлы или целые тома. При полном отказе системного диска — переустановка через bootstrap.sh + восстановление данных из реплики.'));

// ── 3. Персонал ──
children.push(h1('3. ИНФОРМАЦИЯ О ПЕРСОНАЛЕ'));

children.push(p('Для обеспечения надлежащей поддержки ПК «rusNAS» персонал ООО «Техномакс-Красноярск» включает:'));
children.push(bullet('Разработчиков с высшим профессиональным образованием в области информационных технологий и опытом разработки системного ПО (Linux, Python, JavaScript, сетевые протоколы)'));
children.push(bullet('Системных инженеров с опытом администрирования Linux-серверов, RAID-массивов, сетевого оборудования'));
children.push(bullet('Специалистов технической поддержки для обработки обращений пользователей'));

children.push(p('Адрес размещения персонала: 660018, Красноярский край, г. Красноярск, ул. Новосибирская, д. 42.'));

// ── 4. Документация ──
children.push(h1('4. ТЕХНИЧЕСКАЯ И ЭКСПЛУАТАЦИОННАЯ ДОКУМЕНТАЦИЯ'));

children.push(p('Комплект документации ПК «rusNAS» включает:'));

const docTable = new Table({
  width: { size: 9000, type: WidthType.DXA },
  columnWidths: [500, 3500, 3000, 2000],
  rows: [
    new TableRow({ children: [
      cell('№', { header: true, width: 500 }),
      cell('Документ', { header: true, width: 3500 }),
      cell('Формат / расположение', { header: true, width: 3000 }),
      cell('Обновление', { header: true, width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('1', { width: 500 }),
      cell('Техническое задание', { width: 3500 }),
      cell('DOCX, certification-docs/', { width: 3000 }),
      cell('При изменении требований', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('2', { width: 500 }),
      cell('Руководство пользователя (PDF)', { width: 3500 }),
      cell('PDF, certification-docs/', { width: 3000 }),
      cell('При каждом релизе', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('3', { width: 500 }),
      cell('Пользовательская документация (онлайн)', { width: 3500 }),
      cell('MkDocs, https://<IP>/help/', { width: 3000 }),
      cell('Автоматически', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('4', { width: 500 }),
      cell('Разработческая документация (онлайн)', { width: 3500 }),
      cell('MkDocs, GitHub Pages', { width: 3000 }),
      cell('Автоматически (GH Actions)', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('5', { width: 500 }),
      cell('Спецификации модулей (18 шт.)', { width: 3500 }),
      cell('Markdown, rusnas-*-task.md', { width: 3000 }),
      cell('При изменении архитектуры', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('6', { width: 500 }),
      cell('Журнал дефектов', { width: 3500 }),
      cell('Markdown, bugs.md', { width: 3000 }),
      cell('При каждом баг-фиксе', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('7', { width: 500 }),
      cell('История проекта', { width: 3500 }),
      cell('Markdown, project_history.md', { width: 3000 }),
      cell('После каждой сессии', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('8', { width: 500 }),
      cell('Описание жизненного цикла', { width: 3500 }),
      cell('DOCX, certification-docs/', { width: 3000 }),
      cell('При изменении процессов', { width: 2000 }),
    ]}),
    new TableRow({ children: [
      cell('9', { width: 500 }),
      cell('Руководство по эксплуатации', { width: 3500 }),
      cell('DOCX, certification-docs/', { width: 3000 }),
      cell('При каждом релизе', { width: 2000 }),
    ]}),
  ]
});
children.push(docTable);

children.push(p('Автоматизация документации: при каждом изменении JS/Python-кода разработчик обязан обновить JSDoc/docstring-аннотации. Команда npm run docs пересобирает всю документацию (43+ страницы). GitHub Actions автоматически публикует обновлённую версию при push в main.'));

// ── 5. Аварийные ситуации ──
children.push(h1('5. АВАРИЙНЫЕ СИТУАЦИИ И СВЯЗЬ С ТЕХНИЧЕСКОЙ ПОДДЕРЖКОЙ'));

children.push(p('В случае возникновения ошибок при работе с ПК «rusNAS» необходимо обратиться к службе поддержки:'));
children.push(bullet('Электронная почта: support@rusnas.ru'));
children.push(bullet('Телефон: +7 (903) 987-13-22'));
children.push(bullet('Онлайн-документация: https://<IP адрес устройства>/help/'));

children.push(p('Режим работы технической поддержки: по рабочим дням с 09:00 до 18:00 (МСК+4, Красноярск). Критические инциденты (потеря данных, атака шифровальщика) обрабатываются в приоритетном порядке.'));

children.push(h2('5.1. Классификация аварийных ситуаций'));

const emergencyTable = new Table({
  width: { size: 9000, type: WidthType.DXA },
  columnWidths: [1500, 3500, 4000],
  rows: [
    new TableRow({ children: [
      cell('Категория', { header: true, width: 1500 }),
      cell('Описание', { header: true, width: 3500 }),
      cell('Действия системы', { header: true, width: 4000 }),
    ]}),
    new TableRow({ children: [
      cell('Критическая', { width: 1500 }),
      cell('Деградация RAID, атака шифровальщика, отказ ИБП с потерей питания', { width: 3500 }),
      cell('Guard: автоснапшот + блокировка IP + уведомление. UPS: автоматическое безопасное отключение. RAID: автовосстановление при наличии spare', { width: 4000 }),
    ]}),
    new TableRow({ children: [
      cell('Существенная', { width: 1500 }),
      cell('Ошибки файловой системы, сбой сервиса (SMB/NFS), переполнение диска', { width: 3500 }),
      cell('Уведомление администратора через Dashboard + Night Report. Анализатор пространства: прогноз заполнения и предупреждение', { width: 4000 }),
    ]}),
    new TableRow({ children: [
      cell('Незначительная', { width: 1500 }),
      cell('Ошибки конфигурации, неверный ввод пользователя', { width: 3500 }),
      cell('Валидация ввода, информативные сообщения об ошибках, возврат в рабочее состояние без потери данных', { width: 4000 }),
    ]}),
  ]
});
children.push(emergencyTable);

children.push(h2('5.2. Встроенные механизмы защиты'));

children.push(p('При ошибках в работе аппаратных средств:'));
children.push(bullet('RAID-массивы обеспечивают избыточность данных (RAID 1/5/6/10)'));
children.push(bullet('S.M.A.R.T.-мониторинг предупреждает о деградации дисков заблаговременно'));
children.push(bullet('Backup Mode (HDD Spindown) сохраняет резервные массивы в спящем режиме'));

children.push(p('При ошибках программного обеспечения:'));
children.push(bullet('Systemd обеспечивает автоматический перезапуск сервисов (Restart=on-failure)'));
children.push(bullet('Guard-демон: отделение socket-сервера от детектора — управление доступно даже при сбое детекции'));
children.push(bullet('Атомарная запись конфигураций (tempfile + rename) предотвращает повреждение при аварийном отключении'));

children.push(p('При неверных действиях пользователей:'));
children.push(bullet('Веб-интерфейс валидирует все операции перед выполнением'));
children.push(bullet('Деструктивные операции (удаление RAID, удаление шары) требуют подтверждения с отображением затрагиваемых данных'));
children.push(bullet('Guard PIN защищает критичные операции независимо от пароля администратора'));
children.push(bullet('Система возвращается в состояние, предшествовавшее ошибочному действию'));

// ── 6. Безопасность ──
children.push(h1('6. ОБЕСПЕЧЕНИЕ ИНФОРМАЦИОННОЙ БЕЗОПАСНОСТИ'));

children.push(p('Меры обеспечения безопасности ПК «rusNAS»:'));
children.push(bullet('Аутентификация: Cockpit PAM + Guard PIN (bcrypt hash) для критичных операций'));
children.push(bullet('Авторизация: sudoers NOPASSWD per-module (минимальные привилегии для каждого модуля)'));
children.push(bullet('Шифрование: HTTPS (Cockpit :9090), TLS для apt-репозитория, SSH для репликации'));
children.push(bullet('Файрвол: nftables с настраиваемыми правилами'));
children.push(bullet('Guard: автоматическая блокировка IP-адресов атакующих через nftables'));
children.push(bullet('Лицензирование: Ed25519 криптографическая подпись, защита от подделки'));
children.push(bullet('Журналирование: все действия системы записываются в системный журнал (journald) и специализированные логи модулей'));
children.push(bullet('Обновления безопасности: доставляются через apt-репозиторий, подписанный GPG-ключом'));

// Build document
const doc = new Document({
  styles: {
    default: { document: { run: { font, size: sz } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, font },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
    ]
  },
  numbering: {
    config: [
      { reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2013', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: 'numbers',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1)', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1134, right: 850, bottom: 1134, left: 1701 } // ГОСТ: 30mm left, 15mm right, 20mm top/bottom
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC', space: 4 } },
          children: [new TextRun({ text: 'rusNAS — Описание процессов жизненного цикла', font, size: 16, color: '999999' })]
        })]
      })
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'Страница ', font, size: 16, color: '999999' }),
            new TextRun({ children: [PageNumber.CURRENT], font, size: 16, color: '999999' })
          ]
        })]
      })
    },
    children
  }]
});

async function build() {
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(OUT, buffer);
  console.log('✓ ' + OUT + ' (' + (buffer.length / 1024).toFixed(0) + ' KB)');
}

build().catch(e => { console.error(e); process.exit(1); });
