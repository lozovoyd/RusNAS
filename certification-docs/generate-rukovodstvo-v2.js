const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, ImageRun
} = require("docx");

const FONT = "Times New Roman";
const PAGE_W = 11906; const PAGE_H = 16838;
const ML = 1701; const MR = 850; const MT = 1134; const MB = 1134;
const CW = PAGE_W - ML - MR; // ~9355 DXA
const IMG_W = 580; // pixels for images in doc (~15cm)
const IMG_H = 326; // 16:9 aspect ratio

const bdr = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
const borders = { top: bdr, bottom: bdr, left: bdr, right: bdr };
const cm = { top: 40, bottom: 40, left: 80, right: 80 };

function p(text, o = {}) {
  const runs = [];
  if (typeof text === "string") {
    runs.push(new TextRun({ text, font: FONT, size: o.size || 28, bold: !!o.bold, italics: !!o.italics }));
  } else if (Array.isArray(text)) {
    text.forEach(t => {
      if (typeof t === "string") runs.push(new TextRun({ text: t, font: FONT, size: o.size || 28 }));
      else runs.push(new TextRun({ font: FONT, size: o.size || 28, ...t }));
    });
  }
  return new Paragraph({
    children: runs, alignment: o.alignment || AlignmentType.JUSTIFIED,
    spacing: { after: o.after !== undefined ? o.after : 120, before: o.before || 0, line: o.line || 360 },
    indent: o.indent ? { firstLine: o.indent } : undefined,
    ...(o.heading ? { heading: o.heading } : {}),
    ...(o.pageBreakBefore ? { pageBreakBefore: true } : {}),
  });
}
function h1(t, pb) { return new Paragraph({ children: [new TextRun({ text: t.toUpperCase(), font: FONT, size: 32, bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240, line: 360 }, heading: HeadingLevel.HEADING_1, pageBreakBefore: !!pb }); }
function h2(t) { return new Paragraph({ children: [new TextRun({ text: t, font: FONT, size: 30, bold: true })], spacing: { before: 200, after: 120, line: 360 }, heading: HeadingLevel.HEADING_2 }); }
function h3(t) { return new Paragraph({ children: [new TextRun({ text: t, font: FONT, size: 28, bold: true })], spacing: { before: 160, after: 100, line: 360 }, heading: HeadingLevel.HEADING_3 }); }
function e() { return new Paragraph({ children: [new TextRun({ text: "", font: FONT, size: 28 })], spacing: { after: 0 } }); }
function bullet(t) { return p("\u2014 " + t, { indent: 720 }); }
function step(n, t) { return p(n + ". " + t, { indent: 720 }); }

function tRow(cells, hdr) {
  return new TableRow({ children: cells.map(c => new TableCell({
    borders, margins: cm, width: { size: c.w, type: WidthType.DXA },
    shading: hdr ? { fill: "D9E2F3", type: ShadingType.CLEAR } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: c.t, font: FONT, size: 22, bold: !!hdr })], alignment: AlignmentType.LEFT, spacing: { after: 30, line: 264 } })],
  })) });
}
function tbl(hdrs, rows, ws) {
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: ws,
    rows: [tRow(hdrs.map((h, i) => ({ t: h, w: ws[i] })), true), ...rows.map(r => tRow(r.map((c, i) => ({ t: c, w: ws[i] })), false))] });
}

// Image helper - read PNG from screenshots/ and embed
function img(filename, caption, w, h) {
  const imgPath = path.join(__dirname, 'screenshots', filename);
  if (!fs.existsSync(imgPath)) {
    return [p("[Скриншот: " + caption + " — файл не найден: " + filename + "]", { italics: true, alignment: AlignmentType.CENTER })];
  }
  const imgData = fs.readFileSync(imgPath);
  const imgW = w || IMG_W;
  const imgH = h || IMG_H;
  return [
    new Paragraph({
      children: [new ImageRun({
        type: "png",
        data: imgData,
        transformation: { width: imgW, height: imgH },
        altText: { title: caption, description: caption, name: filename },
      })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 60 },
    }),
    p([{ text: "Рис. " + caption, italics: true }], { alignment: AlignmentType.CENTER, size: 22, after: 200 }),
  ];
}

async function main() {
  const doc = new Document({
    styles: {
      default: { document: { run: { font: FONT, size: 28 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true, font: FONT }, paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 30, bold: true, font: FONT }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: FONT }, paragraph: { spacing: { before: 160, after: 100 }, outlineLevel: 2 } },
      ],
    },
    sections: [
      // TITLE PAGE
      {
        properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MT, bottom: MB, left: ML, right: MR } } },
        children: [
          e(), e(), e(), e(),
          p("ООО «РусНАС»", { alignment: AlignmentType.CENTER, size: 32, bold: true }),
          e(), e(), e(),
          p("Программный комплекс управления", { alignment: AlignmentType.CENTER, size: 32 }),
          p("сетевым хранилищем данных", { alignment: AlignmentType.CENTER, size: 32 }),
          p([{ text: "«RusNAS»", bold: true }], { alignment: AlignmentType.CENTER, size: 36 }),
          e(), e(),
          p("Руководство по эксплуатации экземпляра программного обеспечения,", { alignment: AlignmentType.CENTER, size: 28, bold: true }),
          p("предоставленного для проведения экспертной проверки", { alignment: AlignmentType.CENTER, size: 28, bold: true }),
          e(), e(), e(), e(), e(), e(), e(), e(), e(), e(), e(), e(), e(),
          p("Москва, 2026", { alignment: AlignmentType.CENTER, size: 32 }),
        ],
      },
      // MAIN CONTENT
      {
        properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MT, bottom: MB, left: ML, right: MR } } },
        headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: "ПК RusNAS — Руководство по эксплуатации", font: FONT, size: 20, italics: true })], alignment: AlignmentType.RIGHT })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: "Стр. ", font: FONT, size: 20 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })], alignment: AlignmentType.CENTER })] }) },
        children: [
          // I. ДОСТУП
          h1("I. СВЕДЕНИЯ ДЛЯ ДОСТУПА В СИСТЕМУ"),
          p("Для тестирования и просмотра функционала ПК RusNAS используйте:", { indent: 720 }),
          e(),
          tbl(["Параметр", "Значение"], [
            ["Адрес веб-интерфейса", "https://<IP-адрес>:9090/"],
            ["Логин", "rusnas"],
            ["Пароль", "kl4389qd"],
            ["Права доступа", "Администратор системы (sudo)"],
            ["Guard PIN-код", "Устанавливается при первом входе в модуль Guard"],
          ], [3000, 6355]),
          e(),

          // II. ТРЕБОВАНИЯ
          h1("II. ТРЕБОВАНИЯ ДЛЯ РАБОТОСПОСОБНОСТИ"),
          h2("2.1. Требования к серверу"),
          tbl(["Параметр", "Минимальное", "Рекомендуемое"], [
            ["ОС", "Debian 13 Trixie (x86_64)", "Debian 13 Trixie (x86_64)"],
            ["CPU", "2 ядра, 2.0 ГГц", "4+ ядра, 2.5+ ГГц"],
            ["RAM", "2 ГБ", "8 ГБ и более"],
            ["Системный диск", "16 ГБ", "32 ГБ SSD"],
            ["Диски данных", "2 диска", "4+ диска (RAID 5/6)"],
            ["Сеть", "1x 1 Гбит/с", "2x 1 Гбит/с или 10 Гбит/с"],
          ], [2500, 3427, 3428]),
          e(),
          h2("2.2. Требования к рабочему месту"),
          bullet("Браузер: Chrome 90+, Firefox 90+, Edge 90+."),
          bullet("Разрешение экрана: от 1280x800px. Мобильные: от 390px (адаптивная вёрстка)."),
          e(),

          // III. КОНТАКТЫ
          h1("III. КОНТАКТЫ ЗАЯВИТЕЛЯ"),
          tbl(["Параметр", "Значение"], [
            ["Организация", "ООО «РусНАС»"],
            ["Email", "support@rusnas.ru"],
            ["Телефон", "+7 (___) ___-__-__"],
          ], [3000, 6355]),
          e(),

          // IV. РУКОВОДСТВО
          h1("IV. РУКОВОДСТВО ПО ЭКСПЛУАТАЦИИ", true),

          // 1. Запуск и вход
          h2("1. Запуск программы и вход в систему"),
          p("Откройте браузер и перейдите по адресу: https://<IP-адрес>:9090/", { indent: 720 }),
          p("На экране появится страница аутентификации RusNAS:", { indent: 720 }),
          ...img("01_login.png", "Страница аутентификации RusNAS"),
          step(1, "Введите имя пользователя в поле «Имя пользователя»."),
          step(2, "Введите пароль в поле «Пароль»."),
          step(3, "Нажмите кнопку «Войти»."),
          step(4, "После входа включите административный доступ (иконка замка в верхней панели)."),
          e(),

          // 2. Dashboard
          h2("2. Панель мониторинга (Dashboard)", true),
          p("Главная страница системы. Отображает все ключевые метрики в реальном времени:", { indent: 720 }),
          ...img("02_dashboard.png", "Панель мониторинга (Dashboard)"),
          p([{ text: "Элементы дашборда:", bold: true }], { indent: 720 }),
          bullet("Верхняя строка: информация о системе (IP, uptime, версия), дата/время."),
          bullet("Ночной отчёт: автоматическая сводка за 8 часов (Health Score, инциденты, SMART)."),
          ...img("34_dashboard_nightreport.png", "Dashboard — Ночной отчёт (Night Report)"),
          bullet("4 карточки: Storage (объём), RAID (статус массивов), Диски (S.M.A.R.T.), Общий доступ (SMB/NFS/FTP/WebDAV)."),
          bullet("Метрики: CPU, RAM, Сеть (со спарклайнами), Дисковый I/O, IOPS."),
          bullet("Нижние карточки: события, снапшоты, ИБП, приложения."),
          ...img("35_dashboard_bottom.png", "Dashboard — нижняя часть (события, снапшоты, ИБП)"),
          e(),

          // 3. Storage
          h2("3. Хранилище (Storage)", true),
          p("Управление сетевыми шарами и протоколами. Содержит вкладки: Шары, iSCSI, WORM, Сервисы, Файловый менеджер.", { indent: 720 }),
          ...img("03_storage_shares.png", "Хранилище — вкладка «Шары»"),
          h3("3.1. Создание сетевой шары"),
          step(1, "Нажмите кнопку «+ Создать шару» (зелёная кнопка справа)."),
          step(2, "В модальном окне заполните вкладку «Основные»: имя, том, путь."),
          step(3, "Включите SMB и/или NFS на соответствующих вкладках."),
          step(4, "Настройте права доступа и нажмите «Сохранить»."),
          ...img("20_modal_create_share.png", "Модальное окно создания сетевой шары"),
          e(),
          h3("3.2. Редактирование и удаление"),
          bullet("Кнопка «Изменить» — открывает модальное окно с текущими параметрами."),
          bullet("Кнопка «Удалить» — удаляет конфигурацию (директория на диске сохраняется)."),
          bullet("Кнопка «Файлы» — открывает FileBrowser для просмотра содержимого шары."),
          e(),
          h3("3.3. iSCSI"),
          p("Вкладка iSCSI предоставляет управление LUN-устройствами и iSCSI-таргетами:", { indent: 720 }),
          bullet("LUN Manager — создание и удаление блочных устройств (fileio/block)."),
          bullet("Target Manager — создание таргетов, привязка LUN, настройка ACL."),
          ...img("21_storage_iscsi.png", "Вкладка iSCSI"),
          e(),
          h3("3.4. WORM (защита от перезаписи)"),
          p("Вкладка WORM обеспечивает защиту данных от модификации и удаления:", { indent: 720 }),
          bullet("Добавление путей с политикой WriteOnce."),
          bullet("Таблица защищённых путей с датой активации."),
          ...img("22b_storage_worm.png", "Вкладка WORM"),
          e(),
          h3("3.5. Сервисы (FTP + WebDAV)"),
          p("Вкладка «Сервисы» содержит карточки управления FTP и WebDAV:", { indent: 720 }),
          bullet("FTP: старт/стоп, настройки anonymous/chroot, passive ports."),
          bullet("WebDAV: старт/стоп, управление пользователями (digest auth)."),
          ...img("22_storage_services.png", "Вкладка Сервисы (FTP + WebDAV)"),
          e(),

          // 4. Disks
          h2("4. Диски и RAID", true),
          p("Полное управление RAID-массивами, дисками, SSD-кешированием и режимом Backup Mode.", { indent: 720 }),
          ...img("04_disks_raid.png", "Страница «Диски и RAID»"),
          h3("4.1. Создание RAID-массива"),
          step(1, "Нажмите «+ Создать массив» (зелёная кнопка)."),
          step(2, "Шаг 1: выберите уровень RAID (0/1/5/6/10) и отметьте диски."),
          step(3, "Шаг 2: система создаёт массив, форматирует Btrfs и монтирует. Лог прогресса отображается."),
          ...img("23_modal_create_raid.png", "Мастер создания RAID-массива"),
          e(),
          h3("4.2. Операции с массивом"),
          bullet("Расширить массив — добавить диск + автоматический grow."),
          bullet("Субтома — управление подтомами Btrfs (создание/удаление)."),
          ...img("24_subvolumes.png", "Управление субтомами Btrfs"),
          bullet("Backup Mode — автоматическое засыпание дисков при бездействии."),
          bullet("Удалить — остановка, обнуление суперблоков, очистка fstab."),
          e(),
          h3("4.3. Физические диски"),
          p("Таблица физических дисков с моделью, серийным номером, привязкой к массиву и статусом S.M.A.R.T.", { indent: 720 }),
          bullet("Кнопка «Извлечь» — безопасное извлечение диска из массива (fail → remove)."),
          e(),
          h3("4.4. SSD-кеширование"),
          p("Секция «SSD-кеширование» внизу страницы. Кнопка «+ Добавить SSD-кеш».", { indent: 720 }),
          bullet("Выбор RAID-массива + SSD-диск + режим (writethrough/writeback)."),
          bullet("Таблица: массив, SSD, режим, эффективность (hit rate), кеш занят."),
          ...img("24b_disks_ssd_section.png", "Секция SSD-кеширования"),
          e(),

          // 5. Users
          h2("5. Пользователи и группы", true),
          ...img("05_users.png", "Страница «Пользователи и группы»"),
          h3("5.1. Создание пользователя"),
          step(1, "Нажмите «+ Добавить пользователя»."),
          step(2, "Заполните логин, пароль, полное имя."),
          step(3, "Нажмите «Создать»."),
          ...img("25_modal_create_user.png", "Модальное окно создания пользователя"),
          e(),
          h3("5.2. Управление группами"),
          step(1, "Нажмите «+ Добавить группу»."),
          step(2, "Введите имя группы и нажмите «Создать»."),
          p("Привязка пользователей к группам определяет доступ к сетевым шарам.", { indent: 720 }),
          e(),

          // 6. Guard
          h2("6. Guard — Антишифровальщик", true),
          p("Модуль обнаружения и блокировки ransomware-атак. При первом входе устанавливается PIN-код (мин. 6 символов).", { indent: 720 }),
          ...img("06_guard.png", "Страница Guard — вкладка «Обзор»"),
          h3("6.1. Обзор"),
          bullet("Статистика: события сегодня, операции/мин, режим обучения, последний снапшот."),
          bullet("Инфографика «Как работает Guard»: 4 метода обнаружения + 3 режима реагирования."),
          bullet("Кнопки «Включить защиту» / «Выключить защиту» — управление детектором."),
          bullet("Переключатель режима: Мониторинг / Активный / Супер-защита."),
          e(),
          h3("6.2. Журнал событий"),
          bullet("Таблица с фильтрацией по методу, статусу, дате."),
          bullet("Экспорт в CSV (до 10 000 записей)."),
          ...img("26_guard_events.png", "Guard — Журнал событий"),
          e(),
          h3("6.3. Настройки"),
          bullet("Включение/отключение каждого метода: Honeypot, Энтропия, IOPS, Расширения."),
          bullet("Порог энтропии: 6.5–7.5 бит/байт (по умолчанию 7.2)."),
          bullet("Контролируемые пути, смена PIN, сокрытие honeypot от SMB."),
          ...img("27_guard_settings.png", "Guard — Настройки"),
          e(),

          // 7. Snapshots
          h2("7. Снапшоты", true),
          ...img("07_snapshots.png", "Страница «Снапшоты»"),
          h3("7.1. Создание снапшота"),
          step(1, "Выберите подтом в дереве слева."),
          step(2, "Нажмите «+ Создать снапшот»."),
          step(3, "Введите метку (необязательно) и подтвердите."),
          e(),
          h3("7.2. Управление снапшотами"),
          bullet("Просмотр — содержимое снапшота."),
          bullet("Восстановить — откат к состоянию на момент снапшота."),
          bullet("Метка — установить пользовательскую метку."),
          bullet("Заблокировать — защитить от автоматического удаления."),
          bullet("Удалить — удалить снапшот."),
          e(),
          h3("7.3. Расписание"),
          p("Вкладка «Расписание» позволяет настроить автоматическое создание снапшотов:", { indent: 720 }),
          bullet("Интервал: ежечасно, ежедневно, еженедельно."),
          bullet("Политика хранения: максимальное количество или срок хранения."),
          ...img("28_snapshots_schedule.png", "Снапшоты — Расписание"),
          e(),
          h3("7.4. Репликация"),
          p("Вкладка «Репликация» обеспечивает передачу снапшотов на удалённый сервер:", { indent: 720 }),
          bullet("Транспорт: btrfs send/receive через SSH."),
          bullet("Инкрементальная передача (после первого полного копирования)."),
          ...img("29_snapshots_replication.png", "Снапшоты — Репликация"),
          e(),

          // 8. Dedup
          h2("8. Дедупликация", true),
          ...img("08_dedup.png", "Страница «Дедупликация»"),
          step(1, "Нажмите «Запустить» для ручного запуска дедупликации."),
          step(2, "Настройте расписание через вкладку «Расписание»."),
          step(3, "Просмотрите историю экономии на вкладке «История»."),
          p("Дедупликация выполняется в фоне с минимальным приоритетом I/O.", { indent: 720 }),
          e(),

          // 9. UPS
          h2("9. ИБП (UPS)", true),
          ...img("09_ups.png", "Страница «ИБП»"),
          h3("9.1. Настройка"),
          step(1, "Подключите ИБП через USB или SNMP."),
          step(2, "Нажмите «Определить USB-ИБП» для автообнаружения."),
          step(3, "Вкладка «Конфигурация» — выбор режима NUT (standalone/netserver/netclient)."),
          step(4, "Вкладка «Защита» — пороги безопасного выключения."),
          e(),
          h3("9.2. Мониторинг"),
          bullet("Вкладка «Статус»: заряд батареи, запас хода, нагрузка, напряжение, модель."),
          bullet("Вкладка «Журнал событий»: 20 последних событий NUT."),
          e(),

          // 10. Analyzer
          h2("10. Анализатор пространства", true),
          ...img("10_analyzer.png", "Анализатор пространства — Обзор с treemap"),
          p("5 вкладок для анализа использования дискового пространства:", { indent: 720 }),
          bullet("Обзор — карта заполнения (treemap), метрики (занято/свободно/%), прогноз."),
          bullet("Шары — таблица шар со спарклайнами и прогнозом."),
          ...img("32_analyzer_shares.png", "Анализатор — Шары"),
          bullet("Папки и файлы — интерактивная навигация по директориям."),
          ...img("32b_analyzer_files.png", "Анализатор — Папки и файлы (treemap навигация)"),
          bullet("Пользователи — потребление по пользователям с квотами."),
          ...img("33b_analyzer_users.png", "Анализатор — Пользователи"),
          bullet("Типы файлов — кольцевая диаграмма + таблица."),
          ...img("33_analyzer_filetypes.png", "Анализатор — Типы файлов (кольцевая диаграмма)"),
          e(),

          // 11. Network
          h2("11. Сеть", true),
          ...img("11_network.png", "Страница «Сеть» — Интерфейсы"),
          h3("11.1. Интерфейсы"),
          bullet("Карточки сетевых интерфейсов: IP, шлюз, MAC, MTU, режим, трафик (спарклайны)."),
          bullet("Кнопка «Настроить» — редактирование IP/DHCP/IPv6/MTU."),
          e(),
          h3("11.2. DNS и хосты"),
          bullet("Вкладка «DNS и хосты» — nameservers + /etc/hosts."),
          ...img("31_network_dns.png", "Сеть — DNS и хосты"),
          e(),
          h3("11.3. Маршруты"),
          bullet("Вкладка «Маршруты» — статические маршруты с персистентностью."),
          ...img("31b_network_routes.png", "Сеть — Маршруты"),
          e(),
          h3("11.4. Диагностика"),
          bullet("Вкладка «Диагностика» — Ping, Traceroute, DNS Lookup, Port Check, Wake-on-LAN."),
          ...img("30_network_diagnostics.png", "Сеть — Диагностика"),
          e(),
          h3("11.5. Сертификаты и домен"),
          bullet("Вкладка «Сертификаты» — управление TLS-сертификатами (certbot)."),
          bullet("Вкладка «Домен» — DDNS-конфигурация."),
          e(),

          // 12. AI
          h2("12. AI-ассистент", true),
          ...img("12_ai.png", "Страница «AI Ассистент» — чат-интерфейс"),
          h3("12.1. Настройка"),
          step(1, "Выберите провайдера: Yandex GPT 5 Pro или Anthropic Claude."),
          step(2, "Введите API-ключ (для Yandex — также Folder ID)."),
          e(),
          h3("12.2. Использование"),
          p("Введите вопрос на естественном языке. AI имеет 11 инструментов:", { indent: 720 }),
          bullet("Управление: get-status, list-shares, list-disks, list-raid, list-users."),
          bullet("Снапшоты: list-snapshots, create-snapshot, delete-snapshot."),
          bullet("Диагностика: get-events, run-smart-test, get-smart."),
          e(),

          // 13. Performance
          h2("13. Оптимизация производительности", true),
          ...img("13_performance.png", "Страница «Performance Tuner»"),
          p("Автоматический оптимизатор с 12 уровнями настройки.", { indent: 720 }),
          bullet("Верхний блок «Профиль системы»: ОЗУ, CPU, диски, RAID, сеть, TuneD."),
          bullet("Таблица параметров: текущее значение (белым), рекомендуемое (зелёным/жёлтым/красным)."),
          bullet("Кнопка «Применить» — мгновенное применение без перезагрузки."),
          bullet("Кнопка «Рекомендуется» — показывает оптимальное значение для данной конфигурации."),
          bullet("«Применить выбранные» — массовое применение всех отмеченных параметров."),
          bullet("«Откатить всё» — возврат всех параметров к прежним значениям."),
          e(),

          // V. TROUBLESHOOTING
          h1("V. УСТРАНЕНИЕ НЕПОЛАДОК", true),
          tbl(["Проблема", "Причина", "Решение"], [
            ["Страница не загружается", "Cockpit не запущен", "SSH: sudo systemctl start cockpit.socket"],
            ["Guard пустой экран", "PIN не установлен / iframe ждёт", "Подождите 5–8 сек; при первом входе установите PIN"],
            ["RAID degraded", "Rebuild в процессе", "Дождитесь завершения (прогресс на карточке)"],
            ["UPS «Загрузка...»", "NUT не сконфигурирован / нет ИБП", "Нажмите «Определить USB-ИБП»"],
            ["Нет прогноза в Анализаторе", "Менее 2 точек данных", "Данные собираются ежечасно, дождитесь 2+ сборов"],
            ["AI не отвечает", "API-ключ не введён", "Настройте провайдера и введите ключ"],
            ["Сессия сбрасывается", "Timeout Cockpit", "Переаутентифицируйтесь; включите admin доступ"],
            ["Performance пустой", "JS ошибка загрузки", "Обновите страницу (F5); проверьте admin доступ"],
          ], [2500, 2500, 4355]),
          e(),

          // VI. ВЫХОД
          h1("VI. ВЫХОД ИЗ СИСТЕМЫ"),
          step(1, "Нажмите на имя пользователя в верхнем правом углу."),
          step(2, "Выберите «Выход» в выпадающем меню."),
          e(),
        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  const out = path.join(__dirname, "Rukovodstvo_po_Ekspluatacii_RusNAS.docx");
  fs.writeFileSync(out, buf);
  console.log("Generated: " + out + " (" + buf.length + " bytes)");
}

main().catch(e => { console.error(e); process.exit(1); });
