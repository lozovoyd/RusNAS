#!/usr/bin/env node
/**
 * Генератор: Инструкция по установке rusNAS для экспертной проверки
 * Output: certification-docs/RusNAS_Инструкция_по_установке.docx
 */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, LevelFormat,
  BorderStyle, WidthType, ShadingType, PageNumber, PageBreak
} = require('docx');

const OUT = path.join(__dirname, 'RusNAS_Инструкция_по_установке.docx');
const font = 'Times New Roman';
const sz = 24;

function h1(t) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 },
    children: [new TextRun({ text: t, font, size: 28, bold: true })] });
}
function h2(t) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: t, font, size: 26, bold: true })] });
}
function p(t, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60, line: 360 },
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
    indent: opts.noIndent ? undefined : { firstLine: 709 },
    children: [new TextRun({ text: t, font, size: sz, ...(opts.bold ? {bold:true} : {}), ...(opts.italic ? {italics:true} : {}) })]
  });
}
function code(t) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    shading: { fill: 'F0F0F0', type: ShadingType.CLEAR },
    indent: { left: 400 },
    children: [new TextRun({ text: t, font: 'Courier New', size: 20 })]
  });
}
function bullet(t) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { before: 40, after: 40, line: 360 },
    children: [new TextRun({ text: t, font, size: sz })]
  });
}
function step(n, t) {
  return new Paragraph({
    spacing: { before: 100, after: 60, line: 360 },
    indent: { firstLine: 709 },
    children: [
      new TextRun({ text: `${n}. `, font, size: sz, bold: true }),
      new TextRun({ text: t, font, size: sz })
    ]
  });
}
function note(t) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    border: { left: { style: BorderStyle.SINGLE, size: 6, color: 'F5A623', space: 8 } },
    indent: { left: 400 },
    children: [
      new TextRun({ text: 'Примечание: ', font, size: sz, bold: true, italics: true }),
      new TextRun({ text: t, font, size: sz, italics: true })
    ]
  });
}

const border = { style: BorderStyle.SINGLE, size: 1, color: '000000' };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(t, opts = {}) {
  return new TableCell({
    borders, width: opts.w ? { size: opts.w, type: WidthType.DXA } : undefined,
    shading: opts.h ? { fill: 'E8E8E8', type: ShadingType.CLEAR } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: [new TextRun({ text: t, font, size: 20, bold: !!opts.h })] })]
  });
}

const c = [];

// ═══ Title page ═══
c.push(new Paragraph({ spacing: { before: 2000 }, children: [] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
  children: [new TextRun({ text: 'ООО «Техномакс-Красноярск»', font, size: 28, bold: true })] }));
c.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
  children: [new TextRun({ text: 'Сетевое хранилище данных корпоративного класса', font, size: sz, color: '666666' })] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 },
  children: [new TextRun({ text: '«rusNAS»', font, size: 36, bold: true })] }));
c.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400, after: 200 },
  children: [new TextRun({ text: 'ИНСТРУКЦИЯ ПО УСТАНОВКЕ\nЭКЗЕМПЛЯРА ПРОГРАММНОГО ОБЕСПЕЧЕНИЯ\nДЛЯ ПРОВЕДЕНИЯ ЭКСПЕРТНОЙ ПРОВЕРКИ', font, size: 28, bold: true })] }));
c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 2000 },
  children: [new TextRun({ text: 'Красноярск, 2026', font, size: sz })] }));
c.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ Способ 1: Тестовый стенд (VM) ═══
c.push(h1('Способ 1. Развёртывание тестового стенда (виртуальная машина)'));

c.push(p('Данный способ предназначен для экспертной проверки ПК «rusNAS» в виртуализированной среде без использования реального серверного оборудования. Тестовый стенд полностью воспроизводит функциональность продукта.'));

c.push(h2('1.1. Системные требования к хост-машине'));

c.push(new Table({
  width: { size: 9000, type: WidthType.DXA }, columnWidths: [3000, 6000],
  rows: [
    new TableRow({ children: [cell('Параметр', {h:true, w:3000}), cell('Требование', {h:true, w:6000})] }),
    new TableRow({ children: [cell('ОС хоста', {w:3000}), cell('Linux (Ubuntu 22.04+, Debian 12+) или macOS с UTM/QEMU', {w:6000})] }),
    new TableRow({ children: [cell('CPU', {w:3000}), cell('x86_64 с поддержкой виртуализации (VT-x/AMD-V), минимум 2 ядра', {w:6000})] }),
    new TableRow({ children: [cell('RAM', {w:3000}), cell('8 ГБ и более (4 ГБ для VM)', {w:6000})] }),
    new TableRow({ children: [cell('Диск', {w:3000}), cell('50 ГБ свободного места', {w:6000})] }),
    new TableRow({ children: [cell('Сеть', {w:3000}), cell('Доступ к локальной сети (bridge networking)', {w:6000})] }),
    new TableRow({ children: [cell('Гипервизор', {w:3000}), cell('QEMU/KVM (рекомендуется), VirtualBox, VMware, UTM (macOS)', {w:6000})] }),
  ]
}));

c.push(h2('1.2. Установка гипервизора (Linux)'));

c.push(step(1, 'Установите необходимые пакеты для работы с виртуальными машинами, выполнив следующие команды в терминале:'));
c.push(code('sudo apt update'));
c.push(code('sudo apt install -y qemu-kvm libvirt-daemon-system virt-manager bridge-utils'));
c.push(code('sudo systemctl enable --now libvirtd'));

c.push(step(2, 'Убедитесь, что виртуализация поддерживается процессором:'));
c.push(code('egrep -c "(vmx|svm)" /proc/cpuinfo'));
c.push(note('Результат должен быть больше 0. Если 0 — включите виртуализацию в BIOS/UEFI.'));

c.push(h2('1.3. Развёртывание виртуальной машины rusNAS'));

c.push(step(1, 'Скачайте образ виртуальной машины rusNAS по ссылке, предоставленной вместе с комплектом документации:'));
c.push(code('https://activate.rusnas.ru/download/rusnas-vm.tar.gz'));

c.push(step(2, 'Распакуйте скачанный архив:'));
c.push(code('tar xzf rusnas-vm.tar.gz'));
c.push(note('В архиве находятся: rusnas.qcow2 (системный диск), rusnas-data1..4.qcow2 (4 диска для RAID), rusnas-vm.xml (конфигурация VM).'));

c.push(step(3, 'Переместите образы дисков в хранилище libvirt:'));
c.push(code('sudo mv rusnas*.qcow2 /var/lib/libvirt/images/'));

c.push(step(4, 'Импортируйте конфигурацию виртуальной машины:'));
c.push(code('sudo virsh define rusnas-vm.xml'));

c.push(step(5, 'Запустите виртуальную машину:'));
c.push(code('sudo virsh start rusnas'));

c.push(step(6, 'Убедитесь, что VM запущена:'));
c.push(code('virsh list --all'));
c.push(p('В списке должна отображаться машина «rusnas» в состоянии «running».', { noIndent: true }));

c.push(step(7, 'Определите IP-адрес виртуальной машины:'));
c.push(code('virsh domifaddr rusnas'));
c.push(note('Запомните полученный IP-адрес — он потребуется для доступа к веб-интерфейсу.'));

c.push(h2('1.4. Первый вход в веб-интерфейс'));

c.push(step(1, 'Откройте веб-браузер (Chrome, Firefox, Edge) и введите в адресной строке:'));
c.push(code('https://<IP-адрес>:9090'));
c.push(note('Браузер покажет предупреждение о самоподписанном сертификате — это нормально для тестовой среды. Нажмите «Дополнительно» → «Продолжить» (или аналогичную кнопку).'));

c.push(step(2, 'На экране авторизации введите учётные данные:'));
c.push(new Table({
  width: { size: 5000, type: WidthType.DXA }, columnWidths: [2000, 3000],
  rows: [
    new TableRow({ children: [cell('Логин', {h:true, w:2000}), cell('rusnas', {w:3000})] }),
    new TableRow({ children: [cell('Пароль', {h:true, w:2000}), cell('kl4389qd', {w:3000})] }),
  ]
}));

c.push(step(3, 'После входа в систему включите административный доступ:'));
c.push(bullet('В левом нижнем углу нажмите «Ограниченный доступ» (или «Limited access»)'));
c.push(bullet('Введите пароль (kl4389qd) и нажмите «Аутентификация»'));
c.push(note('Административный доступ необходим для управления RAID, дисками, Guard и другими модулями.'));

c.push(step(4, 'В боковом меню слева выберите раздел «rusNAS» для перехода к плагину управления хранилищем.'));

c.push(h2('1.5. Проверка работоспособности'));

c.push(p('После входа в систему убедитесь в корректной работе следующих модулей:'));

c.push(new Table({
  width: { size: 9000, type: WidthType.DXA }, columnWidths: [500, 2500, 3000, 3000],
  rows: [
    new TableRow({ children: [cell('№', {h:true, w:500}), cell('Модуль', {h:true, w:2500}), cell('Проверка', {h:true, w:3000}), cell('Ожидаемый результат', {h:true, w:3000})] }),
    new TableRow({ children: [cell('1', {w:500}), cell('Дашборд', {w:2500}), cell('Открыть Дашборд', {w:3000}), cell('Отображаются метрики CPU, RAM, сетевой трафик, статус RAID', {w:3000})] }),
    new TableRow({ children: [cell('2', {w:500}), cell('Хранилище', {w:2500}), cell('Перейти в Хранилище → Шары', {w:3000}), cell('Таблица SMB/NFS шар, статус сервисов', {w:3000})] }),
    new TableRow({ children: [cell('3', {w:500}), cell('Диски и RAID', {w:2500}), cell('Открыть Диски и RAID', {w:3000}), cell('Карточки RAID-массивов, SMART-статус дисков', {w:3000})] }),
    new TableRow({ children: [cell('4', {w:500}), cell('Guard', {w:2500}), cell('Открыть Guard → Обзор', {w:3000}), cell('Статистика защиты, режим работы (Мониторинг/Активный)', {w:3000})] }),
    new TableRow({ children: [cell('5', {w:500}), cell('Снапшоты', {w:2500}), cell('Открыть Снапшоты', {w:3000}), cell('Список снапшотов, кнопка создания', {w:3000})] }),
    new TableRow({ children: [cell('6', {w:500}), cell('Дедупликация', {w:2500}), cell('Открыть Дедупликация', {w:3000}), cell('Статус последнего запуска, экономия', {w:3000})] }),
    new TableRow({ children: [cell('7', {w:500}), cell('ИБП', {w:2500}), cell('Открыть ИБП', {w:3000}), cell('Статус UPS (или сообщение «не настроен»)', {w:3000})] }),
    new TableRow({ children: [cell('8', {w:500}), cell('Анализатор', {w:2500}), cell('Открыть Анализ пространства', {w:3000}), cell('Карточки: объём, использовано, свободно, прогноз', {w:3000})] }),
    new TableRow({ children: [cell('9', {w:500}), cell('Сеть', {w:2500}), cell('Открыть Сеть → Интерфейсы', {w:3000}), cell('Карточки сетевых интерфейсов с IP, MAC, трафиком', {w:3000})] }),
    new TableRow({ children: [cell('10', {w:500}), cell('Производительность', {w:2500}), cell('Открыть Производительность', {w:3000}), cell('Таблица 12 параметров оптимизации', {w:3000})] }),
    new TableRow({ children: [cell('11', {w:500}), cell('AI-ассистент', {w:2500}), cell('Открыть AI', {w:3000}), cell('Чат-интерфейс, поле ввода API-ключа', {w:3000})] }),
    new TableRow({ children: [cell('12', {w:500}), cell('Приложения', {w:2500}), cell('Открыть Приложения', {w:3000}), cell('Каталог из 10 контейнерных приложений', {w:3000})] }),
    new TableRow({ children: [cell('13', {w:500}), cell('Пользователи', {w:2500}), cell('Открыть Пользователи', {w:3000}), cell('Список пользователей и групп, кнопка «Добавить»', {w:3000})] }),
    new TableRow({ children: [cell('14', {w:500}), cell('Документация', {w:2500}), cell('Перейти по https://<IP>/help/', {w:3000}), cell('Онлайн-руководство пользователя (32 раздела)', {w:3000})] }),
  ]
}));

c.push(h2('1.6. Доступ по SSH (для расширенной проверки)'));

c.push(p('Для доступа к серверу по SSH используйте:'));
c.push(code('ssh rusnas@<IP-адрес>'));
c.push(p('Пароль: kl4389qd', { noIndent: true }));
c.push(note('Root-доступ по SSH отключён. Для выполнения привилегированных команд используйте sudo.'));

// ═══ Способ 2: Bootstrap installer ═══
c.push(new Paragraph({ children: [new PageBreak()] }));
c.push(h1('Способ 2. Установка на физический сервер (bootstrap)'));

c.push(p('Данный способ предназначен для развёртывания ПК «rusNAS» на реальном серверном оборудовании с чистой установкой Debian 13 (Trixie).'));

c.push(h2('2.1. Требования к оборудованию'));

c.push(new Table({
  width: { size: 9000, type: WidthType.DXA }, columnWidths: [3000, 6000],
  rows: [
    new TableRow({ children: [cell('Параметр', {h:true, w:3000}), cell('Требование', {h:true, w:6000})] }),
    new TableRow({ children: [cell('Процессор', {w:3000}), cell('x86_64, 2+ ядра (рекомендуется 4+)', {w:6000})] }),
    new TableRow({ children: [cell('RAM', {w:3000}), cell('4 ГБ минимум (8 ГБ рекомендуется)', {w:6000})] }),
    new TableRow({ children: [cell('Системный диск', {w:3000}), cell('32 ГБ+ (SSD рекомендуется)', {w:6000})] }),
    new TableRow({ children: [cell('Диски для данных', {w:3000}), cell('2+ дисков (HDD/SSD) для создания RAID-массивов', {w:6000})] }),
    new TableRow({ children: [cell('Сеть', {w:3000}), cell('Ethernet 1 Гбит/с+, доступ к интернету для установки', {w:6000})] }),
    new TableRow({ children: [cell('ОС', {w:3000}), cell('Debian 13 Trixie (чистая установка, netinst)', {w:6000})] }),
  ]
}));

c.push(h2('2.2. Установка Debian 13'));

c.push(step(1, 'Скачайте ISO-образ Debian 13 Trixie (netinst):'));
c.push(code('https://www.debian.org/devel/debian-installer/'));

c.push(step(2, 'Запишите ISO на USB-накопитель:'));
c.push(code('sudo dd if=debian-13-amd64-netinst.iso of=/dev/sdX bs=4M status=progress'));

c.push(step(3, 'Загрузитесь с USB и выполните установку Debian 13 со следующими параметрами:'));
c.push(bullet('Hostname: rusnas'));
c.push(bullet('Пользователь: rusnas (с правами sudo)'));
c.push(bullet('Раздел: весь системный диск'));
c.push(bullet('Компоненты: SSH server, стандартные системные утилиты (БЕЗ desktop environment)'));

c.push(h2('2.3. Установка rusNAS через bootstrap'));

c.push(step(1, 'Войдите на сервер по SSH:'));
c.push(code('ssh rusnas@<IP-адрес-сервера>'));

c.push(step(2, 'Скачайте и запустите bootstrap-установщик:'));
c.push(code('curl -fsSL https://activate.rusnas.ru/install | sudo bash'));

c.push(note('Скрипт автоматически: добавит apt-репозиторий rusNAS, установит все необходимые пакеты (Cockpit, Samba, NFS, mdadm, Btrfs-progs, NUT и др.), развернёт Cockpit-плагин, настроит systemd-сервисы, откроет необходимые порты в файрволе.'));

c.push(step(3, 'После завершения установки (5-10 минут) активируйте лицензию:'));
c.push(code('sudo rusnas-activate <ЛИЦЕНЗИОННЫЙ-КЛЮЧ>'));
c.push(note('Лицензионный ключ предоставляется вместе с комплектом документации для экспертной проверки.'));

c.push(step(4, 'Откройте веб-интерфейс в браузере:'));
c.push(code('https://<IP-адрес-сервера>:9090'));

c.push(step(5, 'Войдите с учётными данными, созданными при установке Debian (пользователь rusnas).'));

c.push(h2('2.4. Создание RAID-массива'));

c.push(p('После входа в веб-интерфейс создайте RAID-массив для хранения данных:'));

c.push(step(1, 'Перейдите в раздел «Диски и RAID»'));
c.push(step(2, 'Нажмите «+ Создать массив»'));
c.push(step(3, 'Выберите уровень RAID (рекомендуется RAID 5 или RAID 6 для тестирования)'));
c.push(step(4, 'Отметьте диски для включения в массив'));
c.push(step(5, 'Нажмите «Создать» — начнётся процесс инициализации'));
c.push(note('Инициализация RAID может занять от нескольких минут до нескольких часов в зависимости от размера дисков. Прогресс отображается на карточке массива.'));

// ═══ Контакты ═══
c.push(new Paragraph({ children: [new PageBreak()] }));
c.push(h1('Контакты для оперативной связи'));

c.push(p('В случае возникновения вопросов при установке и тестировании ПК «rusNAS» обращайтесь:'));
c.push(new Paragraph({ spacing: { before: 100 }, children: [] }));

c.push(new Table({
  width: { size: 9000, type: WidthType.DXA }, columnWidths: [3000, 6000],
  rows: [
    new TableRow({ children: [cell('Электронная почта', {h:true, w:3000}), cell('support@rusnas.ru', {w:6000})] }),
    new TableRow({ children: [cell('Телефон', {h:true, w:3000}), cell('+7 (903) 987-13-22 / +7 (923) 320-75-77', {w:6000})] }),
    new TableRow({ children: [cell('Адрес', {h:true, w:3000}), cell('660018, Красноярский край, г. Красноярск, ул. Новосибирская, д. 42', {w:6000})] }),
    new TableRow({ children: [cell('Документация онлайн', {h:true, w:3000}), cell('https://<IP-адрес>:9090 → раздел /help/', {w:6000})] }),
    new TableRow({ children: [cell('Разработческая документация', {h:true, w:3000}), cell('https://lozovoyd.github.io/RusNAS/', {w:6000})] }),
  ]
}));

c.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
c.push(p('Режим работы технической поддержки: по рабочим дням с 09:00 до 18:00 (МСК+4, Красноярск).'));
c.push(p('Критические инциденты (невозможность установки, потеря данных) обрабатываются в приоритетном порядке.'));

// ═══ Build ═══
const doc = new Document({
  styles: {
    default: { document: { run: { font, size: sz } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font }, paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, font }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
    ]
  },
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2013', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
  ]},
  sections: [{
    properties: {
      page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 850, bottom: 1134, left: 1701 } }
    },
    headers: { default: new Header({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC', space: 4 } },
      children: [new TextRun({ text: 'rusNAS — Инструкция по установке', font, size: 16, color: '999999' })]
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'Страница ', font, size: 16, color: '999999' }),
        new TextRun({ children: [PageNumber.CURRENT], font, size: 16, color: '999999' })
      ]
    })] }) },
    children: c
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(OUT, buf);
  console.log('✓ ' + OUT + ' (' + (buf.length/1024).toFixed(0) + ' KB)');
}).catch(e => { console.error(e); process.exit(1); });
