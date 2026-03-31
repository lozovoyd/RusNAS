const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageNumber, PageBreak
} = require("docx");

// ============================================================
// Shared helpers (same as TZ)
// ============================================================
const FONT = "Times New Roman";
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN_TOP = 1134;
const MARGIN_BOT = 1134;
const MARGIN_LEFT = 1701;
const MARGIN_RIGHT = 850;
const CONTENT_W = PAGE_W - MARGIN_LEFT - MARGIN_RIGHT;

const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 40, bottom: 40, left: 80, right: 80 };

function p(text, opts = {}) {
  const runs = [];
  if (typeof text === "string") {
    runs.push(new TextRun({ text, font: FONT, size: opts.size || 28, bold: opts.bold || false, italics: opts.italics || false }));
  } else if (Array.isArray(text)) {
    text.forEach(t => {
      if (typeof t === "string") runs.push(new TextRun({ text: t, font: FONT, size: opts.size || 28 }));
      else runs.push(new TextRun({ font: FONT, size: opts.size || 28, ...t }));
    });
  }
  return new Paragraph({
    children: runs,
    alignment: opts.alignment || AlignmentType.JUSTIFIED,
    spacing: { after: opts.after !== undefined ? opts.after : 120, before: opts.before || 0, line: opts.line || 360 },
    indent: opts.indent ? { firstLine: opts.indent } : undefined,
    ...(opts.heading ? { heading: opts.heading } : {}),
    ...(opts.pageBreakBefore ? { pageBreakBefore: true } : {}),
  });
}

function heading1(text, pb) {
  return new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), font: FONT, size: 32, bold: true })],
    alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240, line: 360 },
    heading: HeadingLevel.HEADING_1, pageBreakBefore: pb || false,
  });
}
function heading2(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, size: 30, bold: true })],
    spacing: { before: 200, after: 120, line: 360 }, heading: HeadingLevel.HEADING_2,
  });
}
function emptyLine() {
  return new Paragraph({ children: [new TextRun({ text: "", font: FONT, size: 28 })], spacing: { after: 0 } });
}

function makeTableRow(cells, header) {
  return new TableRow({
    children: cells.map(c => new TableCell({
      borders, margins: cellMargins,
      width: { size: c.width || Math.floor(CONTENT_W / cells.length), type: WidthType.DXA },
      shading: header ? { fill: "D9E2F3", type: ShadingType.CLEAR } : undefined,
      children: [new Paragraph({
        children: [new TextRun({ text: c.text, font: FONT, size: 24, bold: header || false })],
        alignment: AlignmentType.LEFT, spacing: { after: 40, line: 276 },
      })],
    })),
  });
}
function makeTable(headers, rows, colWidths) {
  const widths = colWidths || headers.map(() => Math.floor(CONTENT_W / headers.length));
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      makeTableRow(headers.map((h, i) => ({ text: h, width: widths[i] })), true),
      ...rows.map(r => makeTableRow(r.map((c, i) => ({ text: c, width: widths[i] })), false)),
    ],
  });
}

function docProps() {
  return {
    page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN_TOP, bottom: MARGIN_BOT, left: MARGIN_LEFT, right: MARGIN_RIGHT } },
  };
}
function defaultStyles() {
  return {
    default: { document: { run: { font: FONT, size: 28 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: FONT }, paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, font: FONT }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 1 } },
    ],
  };
}
function headerFooter() {
  return {
    headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: "ПК RusNAS — Документация", font: FONT, size: 20, italics: true })], alignment: AlignmentType.RIGHT })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: "Стр. ", font: FONT, size: 20 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })], alignment: AlignmentType.CENTER })] }) },
  };
}

// ============================================================
// DOC 2: Описание программы (ГОСТ 19.402-78)
// ============================================================
async function generateOpisanie() {
  const doc = new Document({
    styles: defaultStyles(),
    sections: [{
      properties: docProps(),
      ...headerFooter(),
      children: [
        emptyLine(), emptyLine(), emptyLine(),
        p("УТВЕРЖДАЮ", { alignment: AlignmentType.RIGHT, bold: true }),
        p("__________________ / ________________ /", { alignment: AlignmentType.RIGHT }),
        p("«____» ______________ 2026 г.", { alignment: AlignmentType.RIGHT }),
        emptyLine(), emptyLine(), emptyLine(),
        p("ОПИСАНИЕ ПРОГРАММЫ", { alignment: AlignmentType.CENTER, bold: true, size: 36 }),
        emptyLine(),
        p("«Программный комплекс управления сетевым хранилищем данных RusNAS»", { alignment: AlignmentType.CENTER, size: 30, bold: true }),
        emptyLine(),
        p("(в соответствии с ГОСТ 19.402-78)", { alignment: AlignmentType.CENTER, italics: true, size: 24 }),
        emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(),
        p("Москва, 2026", { alignment: AlignmentType.CENTER, size: 32 }),
        new Paragraph({ children: [new PageBreak()] }),

        // 1. Общие сведения
        heading1("1. ОБЩИЕ СВЕДЕНИЯ"),
        heading2("1.1. Обозначение и наименование программы"),
        p("Наименование: «Программный комплекс управления сетевым хранилищем данных RusNAS».", { indent: 720 }),
        p("Краткое обозначение: ПК RusNAS.", { indent: 720 }),

        heading2("1.2. Программное обеспечение, необходимое для функционирования"),
        p("— Операционная система Debian GNU/Linux 13 (Trixie), архитектура x86_64;", { indent: 720 }),
        p("— Cockpit 337+ (веб-платформа администрирования);", { indent: 720 }),
        p("— Python 3.11+ (backend-скрипты и демоны);", { indent: 720 }),
        p("— Samba 4.x (SMB/CIFS);", { indent: 720 }),
        p("— NFS (knfsd);", { indent: 720 }),
        p("— vsftpd (FTP);", { indent: 720 }),
        p("— Apache 2.4 (WebDAV);", { indent: 720 }),
        p("— targetcli-fb (iSCSI LIO);", { indent: 720 }),
        p("— NUT 2.8.1 (Network UPS Tools);", { indent: 720 }),
        p("— mdadm (программный RAID);", { indent: 720 }),
        p("— btrfs-progs (утилиты Btrfs);", { indent: 720 }),
        p("— duperemove 0.11.2 (дедупликация);", { indent: 720 }),
        p("— nginx (обратный прокси);", { indent: 720 }),
        p("— Podman + podman-compose (контейнеры);", { indent: 720 }),
        p("— nftables (файрвол);", { indent: 720 }),
        p("— smartmontools (S.M.A.R.T.).", { indent: 720 }),

        heading2("1.3. Языки программирования"),
        p("— JavaScript (ES5) — клиентская часть (Cockpit-плагин);", { indent: 720 }),
        p("— Python 3 — серверная часть (демоны, API-скрипты, CLI);", { indent: 720 }),
        p("— Bash — скрипты развёртывания и обёртки;", { indent: 720 }),
        p("— HTML5/CSS3 — интерфейс;", { indent: 720 }),
        p("— YAML — Ansible playbooks и docker-compose.", { indent: 720 }),

        // 2. Функциональное назначение
        heading1("2. ФУНКЦИОНАЛЬНОЕ НАЗНАЧЕНИЕ", true),
        p("ПК RusNAS предназначен для решения следующих задач:", { indent: 720 }),
        p("— управление дисковыми массивами RAID (создание, удаление, расширение, апгрейд уровня, мониторинг);", { indent: 720 }),
        p("— управление файловой системой Btrfs (подтома, снапшоты, репликация, дедупликация);", { indent: 720 }),
        p("— предоставление сетевого доступа к данным (SMB, NFS, FTP, WebDAV, iSCSI);", { indent: 720 }),
        p("— защита от ransomware-атак (модуль Guard с 4 методами обнаружения);", { indent: 720 }),
        p("— мониторинг оборудования (CPU, RAM, сеть, диски, S.M.A.R.T., ИБП);", { indent: 720 }),
        p("— автоматическая оптимизация производительности (12 уровней);", { indent: 720 }),
        p("— управление контейнерными приложениями (каталог из 10 приложений);", { indent: 720 }),
        p("— интеллектуальная диагностика через AI-ассистент (Yandex GPT / Claude / Ollama);", { indent: 720 }),
        p("— централизованное обновление парка устройств через apt-репозиторий.", { indent: 720 }),

        // 3. Описание логической структуры
        heading1("3. ОПИСАНИЕ ЛОГИЧЕСКОЙ СТРУКТУРЫ", true),
        heading2("3.1. Алгоритм работы программы"),
        p("ПК RusNAS функционирует как набор взаимодействующих модулей:", { indent: 720 }),
        p("1) Пользователь открывает веб-интерфейс Cockpit (порт 9090) и проходит аутентификацию;", { indent: 720 }),
        p("2) Cockpit загружает плагин RusNAS, отображая боковую навигацию с 12 страницами;", { indent: 720 }),
        p("3) Каждая страница инициализирует свой JS-модуль, который запрашивает данные через cockpit.spawn() и cockpit.file();", { indent: 720 }),
        p("4) Backend-демоны (Guard, metrics, spindown) работают непрерывно, предоставляя данные через сокеты и файлы состояния;", { indent: 720 }),
        p("5) Таймеры systemd периодически запускают сбор метрик, расписание снапшотов и дедупликацию;", { indent: 720 }),
        p("6) nginx проксирует внешние запросы к соответствующим сервисам.", { indent: 720 }),

        heading2("3.2. Структура программы на уровне модулей"),
        makeTable(
          ["Модуль", "Frontend", "Backend", "Хранилище данных"],
          [
            ["Dashboard", "dashboard.html + dashboard.js", "metrics_server.py", "/proc, vnstat, smartctl"],
            ["Storage", "index.html + app.js", "smb.conf, /etc/exports, targetcli", "Конфиги, saveconfig.json"],
            ["Disks & RAID", "disks.html + disks.js", "mdadm, smartctl, spind.py", "/proc/mdstat, JSON state"],
            ["Guard", "guard.html + guard.js", "guard.py (daemon)", "events.jsonl, config.json"],
            ["Snapshots", "snapshots.html + snapshots.js", "rusnas-snap (CLI)", "snaps.db (SQLite)"],
            ["Dedup", "dedup.html + dedup.js", "rusnas-dedup-run.sh", "dedup-last.json, history"],
            ["UPS", "ups.html + ups.js", "NUT (nut-server)", "/etc/nut/*.conf"],
            ["Analyzer", "storage-analyzer.html + .js", "storage-analyzer-api.py", "storage_history.db"],
            ["Network", "network.html + network.js", "network-api.py", "/etc/network/interfaces"],
            ["AI", "ai.html + ai.js", "mcp-api.py", "localStorage (keys)"],
            ["Performance", "performance.html + .js", "/proc/sys/, sysctl", "99-rusnas-perf.conf"],
            ["Containers", "containers.html + .js", "container_api.py", "installed.json, compose/"],
          ],
          [1600, 2800, 2600, 2355]
        ),
        emptyLine(),

        // 4. Используемые технические средства
        heading1("4. ИСПОЛЬЗУЕМЫЕ ТЕХНИЧЕСКИЕ СРЕДСТВА", true),
        p("ПК RusNAS предназначен для работы на серверном оборудовании следующих типов:", { indent: 720 }),
        p("— серверы архитектуры x86_64 (Intel Xeon, AMD EPYC, Intel Core);", { indent: 720 }),
        p("— NAS-устройства с 2–16 отсеками для дисков;", { indent: 720 }),
        p("— виртуальные машины (QEMU/KVM, VMware, Hyper-V);", { indent: 720 }),
        p("— диски: HDD (SATA/SAS), SSD (SATA/NVMe) для данных и кеширования;", { indent: 720 }),
        p("— сетевые адаптеры: 1 Гбит/с и 10 Гбит/с Ethernet;", { indent: 720 }),
        p("— ИБП с поддержкой NUT (USB/SNMP/сетевое подключение).", { indent: 720 }),

        // 5. Вызов и загрузка
        heading1("5. ВЫЗОВ И ЗАГРУЗКА", true),
        p("Программа запускается автоматически при загрузке операционной системы через systemd:", { indent: 720 }),
        p("— cockpit.socket (порт 9090) — веб-интерфейс;", { indent: 720 }),
        p("— rusnas-guard.service — демон антишифровальщика;", { indent: 720 }),
        p("— rusnas-metrics.service — сервер метрик;", { indent: 720 }),
        p("— rusnas-spind.service — демон засыпания дисков;", { indent: 720 }),
        p("— rusnas-snapd.timer — таймер снапшотов;", { indent: 720 }),
        p("— rusnas-storage-collector.timer — таймер сбора метрик хранилища;", { indent: 720 }),
        p("— nginx.service — обратный прокси.", { indent: 720 }),
        emptyLine(),
        p("Доступ к интерфейсу: https://<IP-адрес>:9090/ (веб-браузер).", { indent: 720 }),

        // 6. Входные и выходные данные
        heading1("6. ВХОДНЫЕ И ВЫХОДНЫЕ ДАННЫЕ", true),
        heading2("6.1. Входные данные"),
        p("— параметры конфигурации от администратора (через веб-интерфейс);", { indent: 720 }),
        p("— данные мониторинга: /proc/stat, /proc/meminfo, /proc/net/dev, /proc/mdstat;", { indent: 720 }),
        p("— данные S.M.A.R.T. (smartctl);", { indent: 720 }),
        p("— события файловой системы (inotify — Guard);", { indent: 720 }),
        p("— статус ИБП (upsc JSON);", { indent: 720 }),
        p("— API-ответы AI-провайдеров (JSON).", { indent: 720 }),
        heading2("6.2. Выходные данные"),
        p("— веб-страницы интерфейса (HTML/CSS/JS);", { indent: 720 }),
        p("— JSON-ответы API (/metrics:9100, mcp-api, storage-analyzer-api);", { indent: 720 }),
        p("— Prometheus-метрики (text/plain);", { indent: 720 }),
        p("— журналы событий (systemd journal, /var/log/rusnas/);", { indent: 720 }),
        p("— конфигурационные файлы (smb.conf, /etc/exports, /etc/nut/, /etc/fstab);", { indent: 720 }),
        p("— снапшоты Btrfs (файловая система);", { indent: 720 }),
        p("— уведомления (email, Telegram).", { indent: 720 }),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync("Opisanie_Programmy_RusNAS.docx", buf);
  console.log("Generated: Opisanie_Programmy_RusNAS.docx (" + buf.length + " bytes)");
}

// ============================================================
// DOC 3: Программа и методика испытаний (ГОСТ 19.301-79)
// ============================================================
async function generatePMI() {
  const doc = new Document({
    styles: defaultStyles(),
    sections: [{
      properties: docProps(),
      ...headerFooter(),
      children: [
        emptyLine(), emptyLine(), emptyLine(),
        p("УТВЕРЖДАЮ", { alignment: AlignmentType.RIGHT, bold: true }),
        p("__________________ / ________________ /", { alignment: AlignmentType.RIGHT }),
        p("«____» ______________ 2026 г.", { alignment: AlignmentType.RIGHT }),
        emptyLine(), emptyLine(), emptyLine(),
        p("ПРОГРАММА И МЕТОДИКА ИСПЫТАНИЙ", { alignment: AlignmentType.CENTER, bold: true, size: 36 }),
        emptyLine(),
        p("«Программный комплекс управления сетевым хранилищем данных RusNAS»", { alignment: AlignmentType.CENTER, size: 30, bold: true }),
        emptyLine(),
        p("(в соответствии с ГОСТ 19.301-79)", { alignment: AlignmentType.CENTER, italics: true, size: 24 }),
        emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(), emptyLine(),
        p("Москва, 2026", { alignment: AlignmentType.CENTER, size: 32 }),
        new Paragraph({ children: [new PageBreak()] }),

        heading1("1. ОБЪЕКТ ИСПЫТАНИЙ"),
        p("Объектом испытаний является ПК RusNAS — программный комплекс управления сетевым хранилищем данных, развёрнутый на сервере под управлением Debian 13 Trixie.", { indent: 720 }),

        heading1("2. ЦЕЛЬ ИСПЫТАНИЙ"),
        p("Проверка соответствия функциональных возможностей ПК RusNAS требованиям Технического задания, проверка работоспособности всех модулей, оценка надёжности и безопасности.", { indent: 720 }),

        heading1("3. ТРЕБОВАНИЯ К УСЛОВИЯМ ПРОВЕДЕНИЯ ИСПЫТАНИЙ"),
        p("— сервер x86_64: 4 ядра CPU, 8 ГБ RAM, 1 системный диск + 4 диска данных;", { indent: 720 }),
        p("— установленная ОС Debian 13 Trixie;", { indent: 720 }),
        p("— сетевое подключение: 1 Гбит/с Ethernet;", { indent: 720 }),
        p("— ИБП с USB-подключением (для тестирования модуля UPS);", { indent: 720 }),
        p("— рабочая станция с браузером Chrome/Firefox/Edge;", { indent: 720 }),
        p("— SMB/NFS-клиент для проверки сетевого доступа.", { indent: 720 }),

        heading1("4. ПРОГРАММА ИСПЫТАНИЙ", true),
        makeTable(
          ["№", "Наименование теста", "Модуль", "Ожидаемый результат"],
          [
            ["1", "Создание RAID 5 массива из 3 дисков", "Диски и RAID", "Массив создан, mkfs.btrfs выполнен, смонтирован"],
            ["2", "Создание SMB-шары на RAID-массиве", "Хранилище", "Шара доступна по сети, файлы читаются/пишутся"],
            ["3", "Создание NFS-шары", "Хранилище", "Экспорт виден через showmount, монтируется клиентом"],
            ["4", "Создание iSCSI LUN и Target", "Хранилище", "LUN и Target созданы, подключение iscsiadm успешно"],
            ["5", "Создание снапшота вручную", "Снапшоты", "Снапшот создан, виден в списке и на диске"],
            ["6", "Автоматический снапшот по расписанию", "Снапшоты", "Снапшот создан по таймеру (проверить через 5 мин)"],
            ["7", "Запуск дедупликации", "Дедупликация", "duperemove завершён, сэкономленное место отображено"],
            ["8", "Обнаружение honeypot-атаки", "Guard", "Событие зафиксировано в журнале, снапшот создан"],
            ["9", "Обнаружение высокоэнтропийного файла", "Guard", "Энтропия >7.2, событие в журнале"],
            ["10", "Мониторинг ИБП (USB)", "ИБП", "Статус OL, заряд и время отображены корректно"],
            ["11", "Корректное выключение при OB LB", "ИБП", "Система выполняет shutdown при критическом заряде"],
            ["12", "Отображение Dashboard метрик", "Dashboard", "CPU, RAM, Net, Disk IO обновляются в реальном времени"],
            ["13", "Night Report генерация", "Dashboard", "Health Score отображён, 5 метрик-карточек заполнены"],
            ["14", "Замена диска в RAID", "Диски и RAID", "Диск заменён, rebuild завершён без потери данных"],
            ["15", "Апгрейд RAID 5→6", "Диски и RAID", "Уровень изменён, reshape завершён, FS расширена"],
            ["16", "Создание SSD-кеша", "SSD-кеш", "dm-cache создан, hit rate отображается"],
            ["17", "Настройка сетевого интерфейса", "Сеть", "IP изменён, перенаправление на новый адрес"],
            ["18", "Ping/Traceroute/DNS диагностика", "Сеть", "Результаты отображены в терминале"],
            ["19", "Performance Tuner применение", "Производительность", "Параметры применены, сохранены в sysctl.d"],
            ["20", "Установка контейнера Nextcloud", "Контейнеры", "Nextcloud доступен через nginx proxy"],
            ["21", "AI-чат: запрос статуса", "AI-ассистент", "LLM возвращает ответ с данными get-status"],
            ["22", "Управление пользователями", "Пользователи", "Создание, редактирование, удаление пользователя"],
            ["23", "FTP-доступ к шаре", "Сервисы", "Подключение через FTP-клиент, файлы доступны"],
            ["24", "WebDAV-доступ", "Сервисы", "Подключение через WebDAV-клиент, файлы доступны"],
            ["25", "Backup Mode засыпание дисков", "Диски и RAID", "Диски засыпают после таймаута, пробуждаются при доступе"],
            ["26", "Мобильный интерфейс (390px)", "UI", "Страницы корректно отображаются на узком экране"],
            ["27", "WORM-защита файлов", "Хранилище", "Файлы недоступны для перезаписи после установки защиты"],
            ["28", "Репликация снапшота на удалённый сервер", "Снапшоты", "Снапшот передан через SSH, виден на целевом сервере"],
            ["29", "Storage Analyzer treemap", "Анализатор", "Treemap отображается, навигация по папкам работает"],
            ["30", "Лицензионная активация", "Лицензирование", "Ключ принят, статус активирован, apt-обновления работают"],
          ],
          [500, 3200, 2000, 3655]
        ),
        emptyLine(),

        heading1("5. МЕТОДЫ ИСПЫТАНИЙ", true),
        heading2("5.1. Функциональное тестирование"),
        p("Каждый тест из раздела 4 выполняется последовательно на испытательном стенде. Тестировщик вручную выполняет операции через веб-интерфейс и проверяет результат через:", { indent: 720 }),
        p("— визуальный контроль веб-интерфейса;", { indent: 720 }),
        p("— проверку через SSH-консоль (systemctl, cat, ls, mdadm);", { indent: 720 }),
        p("— проверку через сетевых клиентов (smbclient, mount.nfs, iscsiadm, curl, ftp).", { indent: 720 }),

        heading2("5.2. Нагрузочное тестирование"),
        p("— одновременное подключение 50+ SMB-клиентов к одной шаре;", { indent: 720 }),
        p("— генерация 200 inotify-событий/сек для проверки Guard;", { indent: 720 }),
        p("— проверка Dashboard при высокой нагрузке (все метрики обновляются без зависания).", { indent: 720 }),

        heading2("5.3. Тестирование безопасности"),
        p("— попытка доступа без аутентификации (ожидание: отказ 401/403);", { indent: 720 }),
        p("— попытка эскалации привилегий (ожидание: sudoers блокирует);", { indent: 720 }),
        p("— имитация ransomware: массовое переименование файлов в .encrypted;", { indent: 720 }),
        p("— проверка изоляции контейнеров (Podman mem_limit).", { indent: 720 }),

        heading1("6. КРИТЕРИИ ПРИЁМКИ", true),
        p("Испытания считаются успешными, если:", { indent: 720 }),
        p("— все 30 тестов из раздела 4 пройдены с ожидаемым результатом;", { indent: 720 }),
        p("— отсутствуют критические дефекты (потеря данных, зависание системы);", { indent: 720 }),
        p("— время отклика UI не превышает 3 секунд для основных операций;", { indent: 720 }),
        p("— Guard обнаруживает все имитированные атаки.", { indent: 720 }),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync("Programma_Metodika_Ispytaniy_RusNAS.docx", buf);
  console.log("Generated: Programma_Metodika_Ispytaniy_RusNAS.docx (" + buf.length + " bytes)");
}

// ============================================================
// DOC 4: Ведомость эксплуатационных документов (ГОСТ 19.507-79)
// ============================================================
async function generateVedomost() {
  const doc = new Document({
    styles: defaultStyles(),
    sections: [{
      properties: docProps(),
      ...headerFooter(),
      children: [
        emptyLine(), emptyLine(), emptyLine(),
        p("ВЕДОМОСТЬ ЭКСПЛУАТАЦИОННЫХ ДОКУМЕНТОВ", { alignment: AlignmentType.CENTER, bold: true, size: 36 }),
        emptyLine(),
        p("«Программный комплекс управления сетевым хранилищем данных RusNAS»", { alignment: AlignmentType.CENTER, size: 30, bold: true }),
        emptyLine(),
        p("(в соответствии с ГОСТ 19.507-79)", { alignment: AlignmentType.CENTER, italics: true, size: 24 }),
        emptyLine(), emptyLine(), emptyLine(),
        p("Москва, 2026", { alignment: AlignmentType.CENTER, size: 32 }),
        new Paragraph({ children: [new PageBreak()] }),

        heading1("ВЕДОМОСТЬ ДОКУМЕНТОВ"),
        emptyLine(),
        makeTable(
          ["№ п/п", "Обозначение", "Наименование документа", "ГОСТ", "Примечание"],
          [
            ["1", "RN.ТЗ.001-2026", "Техническое задание", "ГОСТ 19.201-78", "Настоящий комплект"],
            ["2", "RN.ОП.002-2026", "Описание программы", "ГОСТ 19.402-78", "Настоящий комплект"],
            ["3", "RN.ПМИ.003-2026", "Программа и методика испытаний", "ГОСТ 19.301-79", "Настоящий комплект"],
            ["4", "RN.ТП.004-2026", "Текст программы", "ГОСТ 19.401-78", "Исходный код (репозиторий)"],
            ["5", "RN.РА.005-2026", "Руководство администратора", "ГОСТ 19.503-79", "Подлежит разработке"],
            ["6", "RN.РП.006-2026", "Руководство пользователя", "ГОСТ 19.505-79", "Подлежит разработке"],
            ["7", "RN.ВЭД.007-2026", "Ведомость эксплуатационных документов", "ГОСТ 19.507-79", "Настоящий документ"],
          ],
          [700, 1800, 2800, 2000, 2055]
        ),
        emptyLine(), emptyLine(),

        heading1("СОСТАВ ПРОГРАММНОГО КОМПЛЕКСА"),
        emptyLine(),
        makeTable(
          ["Компонент", "Описание", "Размещение"],
          [
            ["Cockpit-плагин RusNAS", "12 HTML-страниц + JS + CSS", "/usr/share/cockpit/rusnas/"],
            ["Guard daemon", "Антишифровальщик (Python)", "/usr/lib/rusnas-guard/"],
            ["rusnas-snap CLI", "Управление снапшотами", "/usr/local/bin/rusnas-snap"],
            ["Metrics server", "Prometheus + JSON endpoint", "/usr/share/cockpit/rusnas/scripts/"],
            ["Network API", "Управление сетью", "/usr/share/cockpit/rusnas/scripts/"],
            ["Storage Analyzer", "Анализ пространства", "/usr/share/cockpit/rusnas/scripts/"],
            ["Container API", "Менеджер контейнеров", "/usr/lib/rusnas/cgi/"],
            ["MCP API proxy", "AI-ассистент backend", "/usr/share/cockpit/rusnas/scripts/"],
            ["Spindown daemon", "HDD засыпание", "/usr/lib/rusnas/spind/"],
            ["License server", "Лицензирование (FastAPI)", "/opt/rusnas-license-server/"],
            ["Dedup runner", "Дедупликация", "/usr/local/bin/rusnas-dedup-run.sh"],
            ["Ansible roles", "Провизионирование", "ansible/roles/ (репозиторий)"],
          ],
          [2600, 2800, 3955]
        ),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync("Vedomost_Dokumentov_RusNAS.docx", buf);
  console.log("Generated: Vedomost_Dokumentov_RusNAS.docx (" + buf.length + " bytes)");
}

// ============================================================
// RUN ALL
// ============================================================
async function main() {
  await generateOpisanie();
  await generatePMI();
  await generateVedomost();
  console.log("\nAll certification documents generated successfully!");
}

main().catch(e => { console.error(e); process.exit(1); });
