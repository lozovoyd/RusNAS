const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak
} = require("docx");

const FONT = "Times New Roman";
const PAGE_W = 11906; const PAGE_H = 16838;
const ML = 1701; const MR = 850; const MT = 1134; const MB = 1134;
const CW = PAGE_W - ML - MR;

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
    children: runs,
    alignment: o.alignment || AlignmentType.JUSTIFIED,
    spacing: { after: o.after !== undefined ? o.after : 120, before: o.before || 0, line: o.line || 360 },
    indent: o.indent ? { firstLine: o.indent } : undefined,
    ...(o.heading ? { heading: o.heading } : {}),
    ...(o.pageBreakBefore ? { pageBreakBefore: true } : {}),
  });
}
function h1(text, pb) {
  return new Paragraph({ children: [new TextRun({ text: text.toUpperCase(), font: FONT, size: 32, bold: true })],
    alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240, line: 360 },
    heading: HeadingLevel.HEADING_1, pageBreakBefore: !!pb });
}
function h2(text) {
  return new Paragraph({ children: [new TextRun({ text, font: FONT, size: 30, bold: true })],
    spacing: { before: 200, after: 120, line: 360 }, heading: HeadingLevel.HEADING_2 });
}
function h3(text) {
  return new Paragraph({ children: [new TextRun({ text, font: FONT, size: 28, bold: true })],
    spacing: { before: 160, after: 100, line: 360 }, heading: HeadingLevel.HEADING_3 });
}
function e() { return new Paragraph({ children: [new TextRun({ text: "", font: FONT, size: 28 })], spacing: { after: 0 } }); }

function tRow(cells, hdr) {
  return new TableRow({ children: cells.map(c => new TableCell({
    borders, margins: cm,
    width: { size: c.w || Math.floor(CW / cells.length), type: WidthType.DXA },
    shading: hdr ? { fill: "D9E2F3", type: ShadingType.CLEAR } : undefined,
    verticalAlign: "center",
    children: [new Paragraph({
      children: [new TextRun({ text: c.t, font: FONT, size: o2s(c), bold: !!hdr })],
      alignment: AlignmentType.LEFT, spacing: { after: 30, line: 264 },
    })],
  })) });
}
function o2s(c) { return c.s || 22; }

function tbl(hdrs, rows, ws) {
  const widths = ws || hdrs.map(() => Math.floor(CW / hdrs.length));
  return new Table({
    width: { size: CW, type: WidthType.DXA }, columnWidths: widths,
    rows: [
      tRow(hdrs.map((h, i) => ({ t: h, w: widths[i] })), true),
      ...rows.map(r => tRow(r.map((c, i) => ({ t: c, w: widths[i] })), false)),
    ],
  });
}

// ── DB Schema table helper ──
function dbTable(tableName, columns, indexes) {
  const kids = [
    h3(tableName),
    tbl(
      ["Поле", "Тип", "Ограничения", "Описание"],
      columns,
      [2000, 1600, 2000, 3755]
    ),
  ];
  if (indexes && indexes.length) {
    kids.push(p([{ text: "Индексы:", bold: true }], { size: 24 }));
    indexes.forEach(idx => kids.push(p("— " + idx, { size: 24, indent: 360 })));
  }
  kids.push(e());
  return kids;
}

// ============================================================
async function main() {
  const doc = new Document({
    styles: {
      default: { document: { run: { font: FONT, size: 28 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: FONT }, paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 30, bold: true, font: FONT }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 28, bold: true, font: FONT }, paragraph: { spacing: { before: 160, after: 100 }, outlineLevel: 2 } },
      ],
    },
    sections: [
      // ── TITLE PAGE ──
      {
        properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MT, bottom: MB, left: ML, right: MR } } },
        children: [
          e(), e(), e(),
          p("УТВЕРЖДАЮ", { alignment: AlignmentType.RIGHT, bold: true }),
          p("__________________ / ________________ /", { alignment: AlignmentType.RIGHT }),
          p([{ text: "«____» ______________ 2026 г." }], { alignment: AlignmentType.RIGHT }),
          e(), e(), e(), e(),
          p("ОПИСАНИЕ АРХИТЕКТУРЫ", { alignment: AlignmentType.CENTER, bold: true, size: 36 }),
          p("СТРУКТУРЫ ДАННЫХ И ПОТОКОВ", { alignment: AlignmentType.CENTER, bold: true, size: 36 }),
          e(),
          p([{ text: "«Программный комплекс управления сетевым хранилищем данных RusNAS»", bold: true }], { alignment: AlignmentType.CENTER, size: 30 }),
          e(),
          p("(Архитектура системы, структуры баз данных, потоки данных,", { alignment: AlignmentType.CENTER, italics: true, size: 24 }),
          p("протоколы взаимодействия, сетевая топология)", { alignment: AlignmentType.CENTER, italics: true, size: 24 }),
          e(), e(), e(), e(), e(), e(), e(), e(), e(), e(), e(),
          p("Москва, 2026", { alignment: AlignmentType.CENTER, size: 32 }),
        ],
      },
      // ── MAIN CONTENT ──
      {
        properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MT, bottom: MB, left: ML, right: MR } } },
        headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: "ПК RusNAS — Архитектура и структуры данных", font: FONT, size: 20, italics: true })], alignment: AlignmentType.RIGHT })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: "Стр. ", font: FONT, size: 20 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })], alignment: AlignmentType.CENTER })] }) },
        children: [

          // ═══════════════════════════════════════════════════════════════
          // 1. ОБЩАЯ АРХИТЕКТУРА
          // ═══════════════════════════════════════════════════════════════
          h1("1. ОБЩАЯ АРХИТЕКТУРА СИСТЕМЫ"),
          h2("1.1. Уровневая модель"),
          p("ПК RusNAS построен по многоуровневой архитектуре. Каждый уровень предоставляет сервисы вышестоящему уровню и использует сервисы нижестоящего.", { indent: 720 }),
          e(),
          tbl(
            ["Уровень", "Компоненты", "Технология / Протокол"],
            [
              ["L1. Аппаратный", "Диски (HDD/SSD/NVMe), NIC, UPS", "SATA/SAS/NVMe, Ethernet, USB/SNMP"],
              ["L2. Ядро ОС", "Драйверы, md (RAID), dm-cache, inotify, nftables", "Linux 6.x kernel"],
              ["L3. Хранилище", "mdadm (RAID), Btrfs (FS), LVM (dm-cache)", "Программный RAID + CoW FS"],
              ["L4. Сетевые сервисы", "Samba, knfsd, vsftpd, Apache WebDAV, LIO iSCSI", "SMB/NFS/FTP/WebDAV/iSCSI"],
              ["L5. Управляющие демоны", "Guard, spind, metrics_server, NUT, snapd timer", "Python 3, systemd"],
              ["L6. API/CGI-слой", "network-api, container_api, storage-analyzer-api, mcp-api, spindown_ctl", "Python 3, cockpit.spawn"],
              ["L7. Веб-интерфейс", "Cockpit + RusNAS плагин (12 страниц)", "HTML5/CSS3/JS (ES5)"],
              ["L8. Обратный прокси", "nginx (:80/:443)", "HTTP/HTTPS reverse proxy"],
              ["L9. Контейнерные приложения", "Podman (10 приложений из каталога)", "OCI containers, podman-compose"],
            ],
            [1800, 3500, 4055]
          ),
          e(),

          h2("1.2. Компонентная диаграмма"),
          p("Схема взаимодействия основных компонентов системы:", { indent: 720 }),
          e(),
          // ASCII diagram as monospaced text
          p([{ text: "┌─────────────────────────────────────────────────────────────────┐", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│                     БРАУЗЕР АДМИНИСТРАТОРА                      │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│                  (Chrome / Firefox / Edge)                      │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "└──────────────────────────┬──────────────────────────────────────┘", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "                           │ HTTPS :443 / :9090", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "┌──────────────────────────▼──────────────────────────────────────┐", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│                    nginx (reverse proxy)                        │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│  :80/:443 → Cockpit:9090 | FileBrowser:8088 | Apps | WebDAV    │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "└───┬──────────┬────────────┬──────────────┬──────────────────────┘", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "    │          │            │              │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "┌───▼───┐ ┌────▼────┐ ┌────▼─────┐ ┌─────▼──────┐", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│Cockpit│ │FileBrow.│ │Container │ │   Apache   │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│ :9090 │ │  :8088  │ │ Apps     │ │WebDAV:8091 │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "└───┬───┘ └─────────┘ └──────────┘ └────────────┘", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "    │ cockpit.spawn() / cockpit.file()", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "┌───▼──────────────────────────────────────────────────┐", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│              RusNAS Cockpit Plugin (12 pages)        │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│  dashboard │ storage │ disks │ guard │ snapshots │…  │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "└──┬──────┬──────┬──────┬──────┬──────┬───────────────┘", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "   │      │      │      │      │      │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "   ▼      ▼      ▼      ▼      ▼      ▼", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: " mdadm  Samba  smartctl Guard  snap  NUT    ← системные утилиты", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: " btrfs  knfsd  LVM     daemon  CLI  upsc   ← и демоны", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "   │      │      │      │      │      │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "   ▼      ▼      ▼      ▼      ▼      ▼", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "┌──────────────────────────────────────────────────────┐", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│           Linux Kernel (md, dm-cache, nftables)      │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "│              Btrfs  │  RAID (mdadm)  │  dm-cache     │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "└──────────────────────────────────────────────────────┘", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "              │          │          │", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "           ┌──▼──┐   ┌──▼──┐   ┌──▼──┐", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "           │ HDD │   │ HDD │   │ SSD │  ← физические диски", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 0, line: 240 }),
          p([{ text: "           └─────┘   └─────┘   └─────┘", font: "Courier New", size: 16 }], { alignment: AlignmentType.LEFT, after: 120, line: 240 }),
          e(),

          // ═══════════════════════════════════════════════════════════════
          // 2. БАЗЫ ДАННЫХ
          // ═══════════════════════════════════════════════════════════════
          h1("2. СТРУКТУРЫ БАЗ ДАННЫХ", true),

          p("ПК RusNAS использует 3 реляционные базы данных SQLite с режимом журналирования WAL (Write-Ahead Logging) для обеспечения конкурентного доступа и целостности данных.", { indent: 720 }),
          e(),

          // ── DB 1: snaps.db ──
          h2("2.1. База данных снапшотов (snaps.db)"),
          p("Расположение: /var/lib/rusnas/snaps.db", { indent: 720, italics: true, size: 24 }),
          p("Назначение: хранение метаданных снапшотов Btrfs, расписаний, событий и задач репликации.", { indent: 720 }),
          e(),

          ...dbTable("snapshots", [
            ["id", "TEXT", "PRIMARY KEY", "UUID снапшота"],
            ["subvol_path", "TEXT", "NOT NULL", "Путь к подтому Btrfs"],
            ["snap_path", "TEXT", "NOT NULL UNIQUE", "Полный путь к снапшоту на диске"],
            ["snap_name", "TEXT", "NOT NULL", "Имя снапшота (timestamp + тип)"],
            ["snap_type", "TEXT", "NOT NULL", "Тип: manual, scheduled, pre-update-all, guard"],
            ["label", "TEXT", "DEFAULT ''", "Пользовательская метка"],
            ["created_at", "TEXT", "NOT NULL", "Дата создания (ISO 8601)"],
            ["size_bytes", "INTEGER", "DEFAULT 0", "Размер exclusive-данных снапшота"],
            ["locked", "INTEGER", "DEFAULT 0", "Флаг блокировки удаления (0/1)"],
            ["valid", "INTEGER", "DEFAULT 1", "Флаг валидности (0 = повреждён)"],
          ]),

          ...dbTable("schedules", [
            ["id", "TEXT", "PRIMARY KEY", "UUID расписания"],
            ["subvol_path", "TEXT", "NOT NULL UNIQUE", "Путь к подтому (1 расписание на подтом)"],
            ["enabled", "INTEGER", "DEFAULT 1", "Включено (0/1)"],
            ["cron_expr", "TEXT", "DEFAULT '0 0 * * *'", "Cron-выражение расписания"],
            ["retention_last", "INTEGER", "DEFAULT 10", "Хранить N последних снапшотов"],
            ["retention_hourly", "INTEGER", "DEFAULT 24", "Хранить N часовых"],
            ["retention_daily", "INTEGER", "DEFAULT 14", "Хранить N дневных"],
            ["retention_weekly", "INTEGER", "DEFAULT 8", "Хранить N недельных"],
            ["retention_monthly", "INTEGER", "DEFAULT 6", "Хранить N месячных"],
            ["notify_email", "INTEGER", "DEFAULT 1", "Уведомлять по email (0/1)"],
          ]),

          ...dbTable("events", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID события"],
            ["event_type", "TEXT", "NOT NULL", "Тип: created, deleted, error, retention, replicated"],
            ["snap_id", "TEXT", "", "UUID связанного снапшота (может быть NULL)"],
            ["subvol_path", "TEXT", "", "Путь к подтому"],
            ["message", "TEXT", "", "Текстовое описание события"],
            ["created_at", "TEXT", "NOT NULL", "Дата события (ISO 8601)"],
          ]),

          ...dbTable("replication_tasks", [
            ["id", "TEXT", "PRIMARY KEY", "UUID задачи репликации"],
            ["subvol_path", "TEXT", "NOT NULL UNIQUE", "Путь к подтому (1 задача на подтом)"],
            ["remote_user", "TEXT", "NOT NULL", "SSH-пользователь на удалённом сервере"],
            ["remote_host", "TEXT", "NOT NULL", "Хост/IP удалённого сервера"],
            ["remote_path", "TEXT", "NOT NULL", "Путь приёмника на удалённом сервере"],
            ["cron_expr", "TEXT", "DEFAULT '0 1 * * *'", "Cron-выражение расписания репликации"],
            ["enabled", "INTEGER", "DEFAULT 1", "Включено (0/1)"],
            ["last_sent_snap", "TEXT", "DEFAULT NULL", "Имя последнего отправленного снапшота"],
            ["last_run_at", "TEXT", "DEFAULT NULL", "Дата последнего запуска"],
            ["last_status", "TEXT", "DEFAULT NULL", "Статус: ok, error, running"],
          ]),

          p([{ text: "Связи между таблицами:", bold: true }], { size: 26 }),
          p("— snapshots.id ← events.snap_id (FK логическая, soft reference);", { indent: 720 }),
          p("— schedules.subvol_path ↔ snapshots.subvol_path (фильтрация по подтому);", { indent: 720 }),
          p("— replication_tasks.subvol_path ↔ snapshots.subvol_path (выбор снапшота для отправки);", { indent: 720 }),
          p("— replication_tasks.last_sent_snap → snapshots.snap_name (определение parent для инкрементальной отправки).", { indent: 720 }),
          e(),

          // ── DB 2: storage_history.db ──
          h2("2.2. База данных анализатора хранилища (storage_history.db)"),
          p("Расположение: /var/lib/rusnas/storage_history.db", { indent: 720, italics: true, size: 24 }),
          p("Назначение: хранение временных рядов метрик использования дискового пространства для прогнозирования и визуализации.", { indent: 720 }),
          e(),

          ...dbTable("volume_snapshots", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["ts", "INTEGER", "NOT NULL", "Unix timestamp сбора данных"],
            ["volume_path", "TEXT", "NOT NULL", "Путь к тому (напр. /mnt/data)"],
            ["total_bytes", "INTEGER", "NOT NULL", "Общий размер тома (байты)"],
            ["used_bytes", "INTEGER", "NOT NULL", "Использовано (байты)"],
            ["free_bytes", "INTEGER", "NOT NULL", "Свободно (байты)"],
          ], ["idx_volume_ts ON volume_snapshots(volume_path, ts)"]),

          ...dbTable("share_snapshots", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["ts", "INTEGER", "NOT NULL", "Unix timestamp сбора данных"],
            ["share_name", "TEXT", "NOT NULL", "Имя сетевой шары"],
            ["path", "TEXT", "NOT NULL", "Путь к директории шары"],
            ["used_bytes", "INTEGER", "NOT NULL", "Использовано (байты)"],
            ["file_count", "INTEGER", "NOT NULL", "Количество файлов"],
          ], ["idx_share_ts ON share_snapshots(share_name, ts)"]),

          ...dbTable("user_snapshots", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["ts", "INTEGER", "NOT NULL", "Unix timestamp сбора данных"],
            ["username", "TEXT", "NOT NULL", "Имя системного пользователя"],
            ["uid", "INTEGER", "NOT NULL", "UID пользователя (1000–60000)"],
            ["used_bytes", "INTEGER", "NOT NULL", "Использовано (байты)"],
          ], ["idx_user_ts ON user_snapshots(username, ts)"]),

          ...dbTable("file_type_snapshots", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["ts", "INTEGER", "NOT NULL", "Unix timestamp сбора данных"],
            ["volume_path", "TEXT", "NOT NULL", "Путь к тому"],
            ["file_type", "TEXT", "NOT NULL", "Тип файлов (video, images, documents...)"],
            ["used_bytes", "INTEGER", "NOT NULL", "Использовано (байты)"],
            ["file_count", "INTEGER", "NOT NULL", "Количество файлов"],
          ]),

          p([{ text: "Связи между таблицами:", bold: true }], { size: 26 }),
          p("— Все 4 таблицы связаны по полю ts (один сеанс сбора данных);", { indent: 720 }),
          p("— volume_snapshots.volume_path ↔ file_type_snapshots.volume_path;", { indent: 720 }),
          p("— share_snapshots.path — физический путь, соответствующий директории на volume_path.", { indent: 720 }),
          e(),

          // ── DB 3: License ──
          h2("2.3. База данных лицензий (rusnas_licenses.db)"),
          p("Расположение: /opt/rusnas-license-server/rusnas_licenses.db (на VPS)", { indent: 720, italics: true, size: 24 }),
          p("Назначение: хранение серийных номеров, лицензий, активаций и аудит-лога.", { indent: 720 }),
          e(),

          ...dbTable("serials", [
            ["serial", "TEXT", "PRIMARY KEY", "Серийный номер устройства"],
            ["issued_at", "INTEGER", "NOT NULL", "Unix timestamp выдачи"],
            ["first_install_at", "INTEGER", "", "Дата первой установки (NULL до активации)"],
            ["batch", "TEXT", "", "Идентификатор партии"],
            ["note", "TEXT", "", "Примечание оператора"],
          ]),

          ...dbTable("licenses", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["serial", "TEXT", "NOT NULL, FK → serials", "Серийный номер (внешний ключ)"],
            ["license_type", "TEXT", "NOT NULL", "Тип: trial, basic, pro, enterprise"],
            ["expires_at", "INTEGER", "", "Unix timestamp окончания (NULL = бессрочная)"],
            ["features_json", "TEXT", "NOT NULL", "JSON-массив включённых фич"],
            ["customer", "TEXT", "", "Название организации-клиента"],
            ["max_volumes", "INTEGER", "DEFAULT 4", "Максимум RAID-массивов"],
            ["created_at", "INTEGER", "NOT NULL", "Дата создания записи"],
            ["created_by", "TEXT", "", "Логин оператора"],
            ["revoked", "INTEGER", "DEFAULT 0", "Отозвана (0/1)"],
          ]),

          ...dbTable("activations", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["serial", "TEXT", "NOT NULL", "Серийный номер"],
            ["license_id", "INTEGER", "FK → licenses(id)", "ID лицензии"],
            ["requested_at", "INTEGER", "NOT NULL", "Unix timestamp запроса"],
            ["ip", "TEXT", "", "IP-адрес клиента при активации"],
            ["activation_code_hash", "TEXT", "", "Хеш кода активации"],
          ]),

          ...dbTable("audit_log", [
            ["id", "INTEGER", "PRIMARY KEY AUTOINCREMENT", "Автоинкрементный ID"],
            ["ts", "INTEGER", "NOT NULL", "Unix timestamp"],
            ["action", "TEXT", "NOT NULL", "Действие: issue, activate, revoke, check"],
            ["serial", "TEXT", "", "Серийный номер (если применимо)"],
            ["ip", "TEXT", "", "IP-адрес"],
            ["details", "TEXT", "", "Дополнительные сведения (JSON)"],
          ]),

          p([{ text: "Связи:", bold: true }], { size: 26 }),
          p("— licenses.serial → serials.serial (FK);", { indent: 720 }),
          p("— activations.license_id → licenses.id (FK);", { indent: 720 }),
          p("— activations.serial → serials.serial (логическая связь).", { indent: 720 }),
          e(),

          // ── ER Diagram (text) ──
          h2("2.4. ER-диаграмма (текстовая)"),
          e(),
          p([{ text: "snaps.db:", font: "Courier New", size: 18, bold: true }], { after: 0, line: 240 }),
          p([{ text: "  schedules ──1:N──> snapshots (по subvol_path)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  snapshots ──1:N──> events    (по snap_id)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  replication_tasks ──1:1──> schedules (по subvol_path)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  replication_tasks.last_sent_snap → snapshots.snap_name", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          e(),
          p([{ text: "storage_history.db:", font: "Courier New", size: 18, bold: true }], { after: 0, line: 240 }),
          p([{ text: "  volume_snapshots ──1:N──> file_type_snapshots (volume_path + ts)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  volume_snapshots ──1:N──> share_snapshots    (volume содержит шары)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  user_snapshots   (standalone, связь по ts)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          e(),
          p([{ text: "rusnas_licenses.db:", font: "Courier New", size: 18, bold: true }], { after: 0, line: 240 }),
          p([{ text: "  serials ──1:N──> licenses    (serial FK)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  licenses ──1:N──> activations (license_id FK)", font: "Courier New", size: 18 }], { after: 0, line: 240 }),
          p([{ text: "  audit_log (standalone, связь по serial)", font: "Courier New", size: 18 }], { after: 120, line: 240 }),
          e(),

          // ═══════════════════════════════════════════════════════════════
          // 3. JSON STATE/CONFIG FILES
          // ═══════════════════════════════════════════════════════════════
          h1("3. ФАЙЛЫ КОНФИГУРАЦИИ И СОСТОЯНИЯ (JSON)", true),
          p("Помимо баз данных, система использует JSON-файлы для хранения конфигурации и оперативного состояния модулей.", { indent: 720 }),
          e(),

          tbl(
            ["Файл", "Модуль", "Тип", "Описание"],
            [
              ["/etc/rusnas-guard/config.json", "Guard", "Конфигурация", "Режим (monitor|active|super_safe), методы обнаружения, пороги, контролируемые пути"],
              ["/etc/rusnas-guard/guard.pin", "Guard", "Секрет", "bcrypt-хеш PIN-кода Guard"],
              ["/var/log/rusnas-guard/events.jsonl", "Guard", "Журнал", "JSON Lines: события обнаружения (метод, файл, энтропия, IP, действие)"],
              ["/etc/rusnas/dedup-config.json", "Dedup", "Конфигурация", "Список томов, аргументы duperemove, cron, enabled"],
              ["/var/lib/rusnas/dedup-last.json", "Dedup", "Состояние", "Результат последнего запуска: статус, saved_bytes, duration"],
              ["/var/lib/rusnas/dedup-history.json", "Dedup", "История", "Массив за 7 дней: [{date, saved_bytes}, ...]"],
              ["/etc/rusnas/ssd-tiers.json", "SSD Cache", "Конфигурация", "Массив тиров: [{vg, backing, cache, mode, created_at}, ...]"],
              ["/etc/rusnas/spindown.json", "Spindown", "Конфигурация", "timeout_min, arrays, suppress_check, enabled"],
              ["/run/rusnas/spindown_state.json", "Spindown", "Состояние (RAM)", "Реальновременное: state, last_io_ts, wakeup_count, arrays[]"],
              ["/var/lib/rusnas/spindown_totals.json", "Spindown", "Персистентное", "wakeup_count_total (переживает рестарт демона)"],
              ["/etc/rusnas/containers/installed.json", "Containers", "Состояние", "Массив: [{appid, nginx_path, proxy_active, host_ports, ...}]"],
              ["/var/lib/rusnas/storage_cache.json", "Analyzer", "Кеш", "Результат последнего сканирования (объёмы, шары, типы файлов)"],
            ],
            [2800, 1200, 1200, 4155]
          ),
          e(),

          h2("3.1. Структура Guard config.json"),
          p([{ text: '{', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "mode": "active",                  // monitor | active | super_safe', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "detection": {', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "honeypot_enabled": true,         // Включить honeypot-файлы', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "entropy_enabled": true,           // Включить энтропийный анализ', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "entropy_threshold": 7.2,          // Порог энтропии (бит/байт)', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "iops_enabled": true,              // Включить детектор IOPS-аномалий', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "extensions_enabled": true,        // Включить проверку расширений', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "hide_smb_baits": true             // Скрыть honeypot от SMB-клиентов', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  },', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "monitored_paths": ["/mnt/data"],    // Пути для мониторинга', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "snapshot_on_attack": true,          // Создавать снапшот при атаке', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "remote_replicate": false            // Реплицировать при атаке', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '}', font: "Courier New", size: 18 }], { after: 120, line: 220 }),
          e(),

          h2("3.2. Структура spindown_state.json (runtime)"),
          p([{ text: '{', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "arrays": {', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    "md127": {', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '      "state": "active",    // active|flushing|standby|waking', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '      "last_io_ts": 1711800000,', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '      "wakeup_count": 3,', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '      "members": ["sdb","sdc","sdd","sde"]', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '    }', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  },', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '  "updated_at": "2026-03-28T12:00:00"', font: "Courier New", size: 18 }], { after: 0, line: 220 }),
          p([{ text: '}', font: "Courier New", size: 18 }], { after: 120, line: 220 }),
          e(),

          // ═══════════════════════════════════════════════════════════════
          // 4. ПРОТОКОЛЫ ВЗАИМОДЕЙСТВИЯ
          // ═══════════════════════════════════════════════════════════════
          h1("4. ПРОТОКОЛЫ ВЗАИМОДЕЙСТВИЯ КОМПОНЕНТОВ", true),

          h2("4.1. Guard Socket Protocol (JSON-RPC)"),
          p("Транспорт: Unix domain socket /run/rusnas-guard/control.sock", { indent: 720 }),
          p("Формат: JSON-запрос → JSON-ответ (newline-delimited)", { indent: 720 }),
          e(),
          tbl(
            ["Команда", "Аутентификация", "Параметры", "Описание"],
            [
              ["status", "Нет", "—", "Получить текущий статус Guard"],
              ["get_events", "Нет", "limit, offset, method, date_from, date_to, status", "Запрос журнала событий с фильтрацией"],
              ["get_config", "Нет", "—", "Получить публичную конфигурацию"],
              ["has_pin", "Нет", "—", "Проверить наличие PIN-файла"],
              ["set_pin_initial", "Нет (только если PIN не установлен)", "pin (min 6 символов)", "Установить первый PIN"],
              ["auth", "PIN или token", "pin / token", "Аутентификация, получение session token"],
              ["start", "PIN/token", "—", "Запустить поток детектора"],
              ["stop", "PIN/token", "—", "Остановить поток детектора"],
              ["set_mode", "PIN/token", "mode: monitor|active|super_safe", "Сменить режим реагирования"],
              ["set_config", "PIN/token", "config: {detection, paths, ...}", "Обновить конфигурацию"],
              ["acknowledge", "PIN/token", "event_id", "Подтвердить событие"],
              ["clear_blocks", "PIN/token", "—", "Снять все IP-блокировки nftables"],
              ["clear_events", "PIN/token", "—", "Очистить журнал событий"],
              ["generate_ssh_key", "PIN/token", "—", "Генерация SSH-ключа для репликации"],
              ["acknowledge_post_attack", "PIN/token", "—", "Снять пост-атакующий режим"],
              ["change_pin", "PIN/token", "new_pin (min 6)", "Сменить PIN-код Guard"],
            ],
            [2200, 1500, 2600, 3055]
          ),
          e(),

          h2("4.2. Container API (CGI)"),
          p("Вызов: cockpit.spawn([\"sudo\",\"-n\",\"python3\",\"/usr/lib/rusnas/cgi/container_api.py\", cmd, ...])", { indent: 720, size: 24 }),
          e(),
          tbl(
            ["Команда", "Аргументы", "Описание"],
            [
              ["get_catalog", "—", "Список приложений из каталога (merge с rusnas-app.json)"],
              ["get_installed", "—", "Список установленных контейнеров"],
              ["install", "appid [params...]", "Установка: compose + nginx + systemd + start"],
              ["uninstall", "appid", "Удаление: down --volumes + prune + rm configs"],
              ["start", "appid", "Запустить контейнеры приложения"],
              ["stop", "appid", "Остановить контейнеры"],
              ["restart", "appid", "Перезапустить контейнеры"],
              ["get_status", "appid", "Статус контейнеров (running/stopped/error)"],
              ["get_logs", "appid [lines]", "Журналы контейнеров (podman-compose logs)"],
              ["check_ports", "port", "Проверить доступность порта (socket.bind)"],
              ["get_resources", "path", "Доступная RAM (МБ) + свободное место (ГБ)"],
            ],
            [2000, 2400, 4955]
          ),
          e(),

          h2("4.3. Storage Analyzer API"),
          p("Вызов: cockpit.spawn([\"sudo\",\"-n\",\"python3\", SA_API, cmd, ...])", { indent: 720, size: 24 }),
          e(),
          tbl(
            ["Команда", "Аргументы", "Описание"],
            [
              ["overview", "—", "Общие метрики: total/used/free/forecast по всем томам"],
              ["shares", "—", "Метрики по шарам: name, path, used_bytes, file_count, history[]"],
              ["files", "path [sort] [ftype] [older_than]", "Список файлов/папок: treemap navigation"],
              ["users", "—", "Использование по UID 1000–60000"],
              ["file_types", "volume_path", "Распределение по типам файлов"],
              ["forecast", "volume_path", "Прогноз заполнения (линейная регрессия)"],
            ],
            [2000, 3000, 4355]
          ),
          e(),

          h2("4.4. Spindown CGI"),
          p("Вызов: cockpit.spawn([\"sudo\",\"-n\",\"python3\",\"/usr/lib/rusnas/cgi/spindown_ctl.py\", cmd, ...])", { indent: 720, size: 24 }),
          e(),
          tbl(
            ["Команда", "Описание"],
            [
              ["get_state", "Текущее состояние всех массивов (из /run/rusnas/spindown_state.json)"],
              ["get_config", "Конфигурация Backup Mode (из /etc/rusnas/spindown.json)"],
              ["set_config", "Обновить конфигурацию (timeout, arrays, enabled)"],
              ["wake_up", "Принудительное пробуждение массива (hdparm + state transition)"],
              ["spindown_now", "Принудительное засыпание (flush + spindown)"],
            ],
            [2000, 7355]
          ),
          e(),

          h2("4.5. MCP AI API Proxy"),
          p("Вызов: cockpit.spawn([\"sudo\",\"-n\",\"python3\", MCP_API, cmd, ...])", { indent: 720, size: 24 }),
          e(),
          tbl(
            ["Команда", "Описание"],
            [
              ["get-status", "Uptime, loadavg, meminfo, df"],
              ["list-shares", "testparm + /etc/exports"],
              ["list-disks", "lsblk + /proc/mdstat"],
              ["list-raid", "mdadm --detail для каждого массива"],
              ["list-snapshots <subvol>", "rusnas-snap list для подтома"],
              ["create-snapshot <subvol> <label>", "Создать снапшот"],
              ["delete-snapshot <subvol> <name>", "Удалить снапшот"],
              ["list-users", "getent passwd + groups"],
              ["get-events [limit]", "Журнал Guard (последние N)"],
              ["run-smart-test <dev>", "Запустить S.M.A.R.T. тест"],
              ["get-smart <dev>", "Результаты S.M.A.R.T."],
              ["ai-chat", "Проксирование запроса к Yandex GPT / Anthropic Claude"],
            ],
            [3000, 6355]
          ),
          e(),

          // ═══════════════════════════════════════════════════════════════
          // 5. ПОТОКИ ДАННЫХ
          // ═══════════════════════════════════════════════════════════════
          h1("5. ПОТОКИ ДАННЫХ", true),

          h2("5.1. Основные потоки данных между модулями"),
          e(),
          tbl(
            ["Поток", "Источник", "Приёмник", "Транспорт", "Данные"],
            [
              ["Dashboard polling", "/proc/*, smartctl, vnstat", "dashboard.js", "cockpit.spawn (bash batch)", "CPU, RAM, Net, IO каждые 2с"],
              ["Guard status", "guard.py socket", "dashboard.js, guard.js", "Unix socket JSON-RPC", "events_24h, mode, iops, baseline"],
              ["Guard → Snapshot", "detector.py", "rusnas-snap CLI", "subprocess", "Автоснапшот при атаке"],
              ["Guard → nftables", "response.py", "nftables kernel", "nft add rule", "Блокировка IP атакующего"],
              ["Snap timer", "systemd timer (5 мин)", "rusnas-snap", "ExecStart", "scheduled-run + replication run-all"],
              ["Storage collect", "systemd timer (1 час)", "storage_history.db", "Python + du", "Объёмы, шары, пользователи, типы"],
              ["Dedup run", "systemd oneshot / cron", "duperemove", "bash wrapper", "Результат → dedup-last.json"],
              ["UPS polling", "upsc -j", "ups.js, dashboard.js", "cockpit.spawn", "Charge, runtime, status flags"],
              ["Performance tune", "/proc/sys/*", "99-rusnas-perf.conf", "cockpit.file", "sysctl параметры"],
              ["Container install", "catalog/*.json", "podman-compose", "CGI → subprocess", "compose up + nginx conf"],
              ["AI tool use", "ai.js → mcp-api.py", "system utils", "subprocess chain", "LLM → tool → result → LLM"],
              ["License check", "license.js → VPS:8765", "FastAPI server", "HTTPS POST", "Serial → activation code"],
              ["Spindown FSM", "spind.py", "/sys/block, hdparm", "File + ioctl", "IO monitoring → sleep/wake"],
              ["Metrics export", "metrics_server.py", "Prometheus / JSON", "HTTP :9100", "Все метрики + spindown"],
            ],
            [1600, 1600, 1600, 1800, 2755]
          ),
          e(),

          h2("5.2. Диаграмма потока обнаружения атаки (Guard)"),
          e(),
          p([{ text: "  inotify (ядро)                     файловая операция", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       │                                    │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       ▼                                    ▼", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  ┌─────────┐  ┌───────────┐  ┌──────────────┐  ┌───────────┐", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │Honeypot │  │ Entropy   │  │IOPS Anomaly  │  │ Extension │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │ Check   │  │ Analysis  │  │ Detection    │  │  Match    │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  └────┬────┘  └─────┬─────┘  └──────┬───────┘  └─────┬─────┘", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       │             │               │                │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       └──────┬──────┴───────┬───────┘                │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "              ▼              ▼                        ▼", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "        ┌──────────────────────────────────────────────┐", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "        │          events.jsonl  (запись события)      │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "        └──────────────────┬─────────────────────────┘", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                           │ mode?", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "              ┌────────────┼────────────┐", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "              ▼            ▼            ▼", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "         monitor       active       super_safe", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "         (log only)   (snapshot     (snapshot ALL", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                      +nftables     +stop services", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                      +close SMB)   +poweroff 30s)", font: "Courier New", size: 17 }], { after: 120, line: 230 }),
          e(),

          h2("5.3. Диаграмма Backup Mode (HDD Spindown FSM)"),
          e(),
          p([{ text: "  ┌─────────┐  timeout  ┌──────────┐  disks off  ┌──────────┐", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │ ACTIVE  │─────────▶│ FLUSHING │───────────▶│ STANDBY  │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │         │◀─────────│          │            │  (спит)  │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  └─────────┘  error    └──────────┘            └────┬─────┘", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       ▲                                             │ I/O", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       │                ┌──────────┐                 │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       └────────────────│ WAKING   │◀────────────────┘", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "          ready          │          │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                         └──────────┘", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          e(),
          p("Переходы:", { bold: true, indent: 720 }),
          p("— ACTIVE → FLUSHING: таймаут бездействия (1–1440 мин); btrfs sync + commit_min=0;", { indent: 720 }),
          p("— FLUSHING → STANDBY: flush завершён; hdparm -Y; mdadm check suppression (idle);", { indent: 720 }),
          p("— STANDBY → WAKING: обнаружена I/O-операция или ручной wake_up;", { indent: 720 }),
          p("— WAKING → ACTIVE: диски готовы; wakeup_count++; restore mdadm check;", { indent: 720 }),
          p("— FLUSHING → ACTIVE: ошибка flush; откат к активному состоянию.", { indent: 720 }),
          e(),

          // ═══════════════════════════════════════════════════════════════
          // 6. СЕТЕВАЯ АРХИТЕКТУРА
          // ═══════════════════════════════════════════════════════════════
          h1("6. СЕТЕВАЯ АРХИТЕКТУРА", true),

          h2("6.1. Карта портов"),
          tbl(
            ["Порт", "Протокол", "Сервис", "Доступ", "Описание"],
            [
              ["22", "TCP", "SSH", "Внутренний", "Удалённое администрирование"],
              ["80", "TCP", "nginx", "Внешний", "HTTP → редирект на HTTPS или landing"],
              ["443", "TCP", "nginx", "Внешний", "HTTPS reverse proxy (основная точка входа)"],
              ["111", "TCP/UDP", "rpcbind", "Внутренний", "NFS portmapper"],
              ["139", "TCP", "Samba", "Внутренний", "NetBIOS Session"],
              ["445", "TCP", "Samba", "Внутренний", "SMB/CIFS (основной)"],
              ["2049", "TCP", "knfsd", "Внутренний", "NFS daemon"],
              ["3260", "TCP", "LIO iSCSI", "Внутренний", "iSCSI target"],
              ["3493", "TCP", "NUT upsd", "Внутренний", "UPS monitoring (NUT netserver)"],
              ["8088", "TCP", "FileBrowser", "Localhost", "Проксируется через nginx /files/"],
              ["8091", "TCP", "Apache", "Localhost", "WebDAV (проксируется через nginx)"],
              ["9090", "TCP", "Cockpit", "Localhost", "Проксируется через nginx"],
              ["9100", "TCP", "metrics_server", "Внутренний", "Prometheus + JSON метрики"],
              ["20048", "TCP", "mountd", "Внутренний", "NFS mount daemon (фиксированный)"],
              ["20000–20100", "TCP", "vsftpd", "Внутренний", "FTP passive data ports"],
              ["8765", "TCP", "License Server", "VPS", "FastAPI лицензирование (на VPS)"],
              ["8766", "TCP", "apt-auth", "VPS", "Авторизация apt-обновлений (на VPS)"],
            ],
            [1000, 900, 1600, 1400, 4455]
          ),
          e(),

          h2("6.2. Диаграмма nginx reverse proxy"),
          e(),
          p([{ text: "  Клиент (браузер)", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "       ▼ :80/:443", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  ┌────────────────────────────────────────────┐", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │               nginx (primary)              │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │                                            │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /cockpit/  → proxy_pass :9090             │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /files/    → proxy_pass :8088/files/      │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /webdav/   → proxy_pass :8091/webdav/     │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /nextcloud → proxy_pass :8080             │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /chat/api/ → rewrite + proxy :3000        │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /chat/ws   → rewrite + proxy :3000 (WS)   │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /chat/     → proxy_pass :3000 (no strip)  │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  │  /<app>/    → proxy_pass :<app_port>       │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  └────────────────────────────────────────────┘", font: "Courier New", size: 17 }], { after: 120, line: 230 }),
          e(),

          h2("6.3. Файрвол (nftables)"),
          p("Основные цепочки:", { indent: 720 }),
          p("— input: разрешены порты из таблицы 6.1 + ICMP + established/related;", { indent: 720 }),
          p("— forward: по умолчанию drop (контейнеры используют host network);", { indent: 720 }),
          p("— Guard dynamic rules: nft add rule inet filter input ip saddr <IP> drop (при атаке);", { indent: 720 }),
          p("— Guard clear: nft flush ruleset + restore base rules (команда clear_blocks).", { indent: 720 }),
          e(),

          // ═══════════════════════════════════════════════════════════════
          // 7. SYSTEMD СЕРВИСЫ И ТАЙМЕРЫ
          // ═══════════════════════════════════════════════════════════════
          h1("7. SYSTEMD СЕРВИСЫ И ТАЙМЕРЫ", true),

          tbl(
            ["Unit", "Тип", "Описание", "Зависимости"],
            [
              ["rusnas-guard.service", "Service (always-on)", "Guard daemon: socket + detector", "network.target"],
              ["rusnas-metrics.service", "Service (always-on)", "Prometheus metrics HTTP :9100", "network.target"],
              ["rusnas-spind.service", "Service (always-on)", "HDD Spindown daemon (FSM)", "local-fs.target"],
              ["rusnas-snapd.timer", "Timer (5 мин)", "Trigger: rusnas-snapd.service", "—"],
              ["rusnas-snapd.service", "Service (oneshot)", "rusnas-snap scheduled-run + replication run-all", "local-fs.target"],
              ["rusnas-storage-collector.timer", "Timer (1 час + 300s jitter)", "Trigger: rusnas-storage-collector.service", "—"],
              ["rusnas-storage-collector.service", "Service (oneshot)", "storage-collector.py → storage_history.db", "local-fs.target"],
              ["rusnas-dedup.service", "Service (oneshot)", "rusnas-dedup-run.sh (Nice=19, idle IO)", "/etc/cron.d/rusnas-dedup"],
              ["rusnas-filebrowser.service", "Service (always-on)", "FileBrowser :8088", "network.target"],
              ["cockpit.socket", "Socket", "Cockpit web UI :9090", "—"],
              ["nginx.service", "Service (always-on)", "Reverse proxy :80/:443", "network.target"],
              ["smbd.service", "Service (always-on)", "Samba SMB/CIFS", "network.target"],
              ["nfs-kernel-server.service", "Service (always-on)", "NFS daemon", "network.target, rpcbind"],
              ["nut.target", "Target", "NUT server + client", "—"],
            ],
            [2800, 1800, 2800, 1955]
          ),
          e(),

          p([{ text: "Граф зависимостей (ключевые):", bold: true }], { size: 26 }),
          e(),
          p([{ text: "  boot → local-fs.target → mdadm assemble → mount /mnt/data", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                            │", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                            ├── rusnas-guard.service", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                            ├── rusnas-spind.service", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                            ├── rusnas-snapd.timer", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                            └── rusnas-storage-collector.timer", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "  network.target → smbd, nfs, nginx, cockpit, metrics, filebrowser", font: "Courier New", size: 17 }], { after: 0, line: 230 }),
          p([{ text: "                 └── nut.target (если ИБП подключён)", font: "Courier New", size: 17 }], { after: 120, line: 230 }),

        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  const out = "/Users/dvl92/projects/RusNAS/certification-docs/Arhitektura_Struktury_Dannyh_RusNAS.docx";
  fs.writeFileSync(out, buf);
  console.log("Generated: " + out + " (" + buf.length + " bytes)");
}

main().catch(e => { console.error(e); process.exit(1); });
