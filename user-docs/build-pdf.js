#!/usr/bin/env node
/**
 * RusNAS User Manual PDF Generator
 * Generates a GOST-formatted DOCX from user-docs markdown files
 * Then converts to PDF via LibreOffice
 *
 * Usage: node user-docs/build-pdf.js
 * Output: certification-docs/RusNAS_Руководство_пользователя.docx
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, LevelFormat,
  BorderStyle, WidthType, ShadingType, PageNumber, PageBreak,
  TableOfContents
} = require('docx');

const DOCS_DIR = path.join(__dirname, 'docs');
const OUT_DIR = path.join(__dirname, '..', 'certification-docs');

// ── Page order matching mkdocs nav ──
const PAGE_ORDER = [
  { section: 'Начало работы', pages: [
    'getting-started/first-login.md',
    'getting-started/interface.md',
    'getting-started/admin-access.md',
  ]},
  { section: 'Хранилище', pages: [
    'storage/shares.md',
    'storage/iscsi.md',
    'storage/worm.md',
    'storage/services.md',
    'storage/filebrowser.md',
  ]},
  { section: 'Диски и RAID', pages: [
    'raid/create.md',
    'raid/manage.md',
    'raid/replace.md',
    'raid/ssd-cache.md',
    'raid/backup-mode.md',
  ]},
  { section: 'Защита данных (Guard)', pages: [
    'guard/overview.md',
    'guard/settings.md',
    'guard/events.md',
  ]},
  { section: 'Снапшоты', pages: [
    'snapshots/manage.md',
    'snapshots/schedule.md',
    'snapshots/replication.md',
  ]},
  { section: 'Дедупликация', pages: ['dedup/index.md'] },
  { section: 'ИБП (UPS)', pages: [
    'ups/setup.md',
    'ups/monitoring.md',
  ]},
  { section: 'Сеть', pages: [
    'network/interfaces.md',
    'network/dns-routes.md',
    'network/diagnostics.md',
  ]},
  { section: 'Анализ пространства', pages: ['analyzer/index.md'] },
  { section: 'Оптимизация производительности', pages: ['performance/index.md'] },
  { section: 'AI-ассистент', pages: ['ai/index.md'] },
  { section: 'Контейнерные приложения', pages: ['containers/index.md'] },
  { section: 'Пользователи и группы', pages: ['users/index.md'] },
  { section: 'Решение проблем', pages: ['troubleshooting.md'] },
];

// ── Markdown → docx paragraph conversion ──
function mdToParas(mdText) {
  const paras = [];
  const lines = mdText.split('\n');
  let inCode = false;
  let codeBlock = [];
  let inTable = false;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      if (inCode) {
        // End code block
        paras.push(new Paragraph({
          spacing: { before: 80, after: 80 },
          shading: { fill: 'F5F5F5', type: ShadingType.CLEAR },
          children: [new TextRun({ text: codeBlock.join('\n'), font: 'Courier New', size: 18 })]
        }));
        codeBlock = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBlock.push(line);
      continue;
    }

    // Tables
    if (line.match(/^\|.*\|$/)) {
      if (line.match(/^\|[\s\-:]+\|$/)) continue; // separator row
      tableRows.push(line.split('|').filter(c => c.trim()).map(c => c.trim()));
      inTable = true;
      continue;
    }
    if (inTable && tableRows.length > 0) {
      paras.push(makeTable(tableRows));
      tableRows = [];
      inTable = false;
    }

    // Empty line
    if (line.trim() === '') {
      continue;
    }

    // Headings (skip # — that's page title, handled by section header)
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      paras.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: cleanMd(h2[1]), bold: true, size: 26, font: 'Arial' })]
      }));
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      paras.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 180, after: 80 },
        children: [new TextRun({ text: cleanMd(h3[1]), bold: true, size: 24, font: 'Arial' })]
      }));
      continue;
    }
    const h4 = line.match(/^#### (.+)/);
    if (h4) {
      paras.push(new Paragraph({
        spacing: { before: 120, after: 60 },
        children: [new TextRun({ text: cleanMd(h4[1]), bold: true, size: 22, font: 'Arial' })]
      }));
      continue;
    }

    // Skip H1 (page title) — section header already created
    if (line.match(/^# /)) continue;

    // Bullet list
    if (line.match(/^[-*] /)) {
      const text = cleanMd(line.replace(/^[-*] /, ''));
      paras.push(new Paragraph({
        numbering: { reference: 'bullets', level: 0 },
        spacing: { before: 40, after: 40 },
        children: parseInline(text)
      }));
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\d+)\. (.+)/);
    if (numMatch) {
      paras.push(new Paragraph({
        numbering: { reference: 'numbers', level: 0 },
        spacing: { before: 40, after: 40 },
        children: parseInline(cleanMd(numMatch[2]))
      }));
      continue;
    }

    // Admonition blocks (MkDocs !!! note, !!! warning, etc.)
    if (line.match(/^!!! /)) {
      const adm = line.replace(/^!!! \w+ "?/, '').replace(/"$/, '');
      if (adm.trim()) {
        paras.push(new Paragraph({
          spacing: { before: 80, after: 80 },
          border: { left: { style: BorderStyle.SINGLE, size: 6, color: 'F5A623', space: 8 } },
          children: [new TextRun({ text: cleanMd(adm), bold: true, italics: true, size: 20, font: 'Arial' })]
        }));
      }
      continue;
    }
    if (line.match(/^\s{4}/) && paras.length > 0) {
      // Admonition content
      paras.push(new Paragraph({
        indent: { left: 400 },
        spacing: { before: 20, after: 20 },
        children: parseInline(cleanMd(line.trim()))
      }));
      continue;
    }

    // Regular paragraph
    paras.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      children: parseInline(cleanMd(line))
    }));
  }

  // Flush remaining table
  if (tableRows.length > 0) {
    paras.push(makeTable(tableRows));
  }

  return paras;
}

function cleanMd(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/[→←↑↓]/g, function(m) { return m; });
}

function parseInline(text) {
  // Split on **bold** and `code` markers, return TextRun array
  const runs = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/);
  for (const part of parts) {
    if (!part) continue;
    const boldMatch = part.match(/^\*\*(.+)\*\*$/);
    const codeMatch = part.match(/^`(.+)`$/);
    if (boldMatch) {
      runs.push(new TextRun({ text: boldMatch[1], bold: true, font: 'Arial', size: 22 }));
    } else if (codeMatch) {
      runs.push(new TextRun({ text: codeMatch[1], font: 'Courier New', size: 20, shading: { fill: 'F0F0F0', type: ShadingType.CLEAR } }));
    } else {
      runs.push(new TextRun({ text: part, font: 'Arial', size: 22 }));
    }
  }
  if (runs.length === 0) runs.push(new TextRun({ text: text, font: 'Arial', size: 22 }));
  return runs;
}

function makeTable(rows) {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const colCount = rows[0] ? rows[0].length : 2;
  const colWidth = Math.floor(9000 / colCount);

  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: Array(colCount).fill(colWidth),
    rows: rows.map((row, idx) => new TableRow({
      children: row.map(cell => new TableCell({
        borders,
        width: { size: colWidth, type: WidthType.DXA },
        shading: idx === 0 ? { fill: 'E8E8E8', type: ShadingType.CLEAR } : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: [new Paragraph({
          children: [new TextRun({
            text: cleanMd(cell),
            bold: idx === 0,
            font: 'Arial',
            size: 20
          })]
        })]
      }))
    }))
  });
}

// ── Build document ──
async function build() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const children = [];
  let sectionNum = 0;

  // Title page
  children.push(new Paragraph({ spacing: { before: 4000 }, children: [] }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: 'rusNAS', font: 'Arial', size: 56, bold: true, color: 'F5A623' })]
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
    children: [new TextRun({ text: 'Сетевое хранилище данных корпоративного класса', font: 'Arial', size: 24, color: '666666' })]
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 600, after: 200 },
    children: [new TextRun({ text: 'РУКОВОДСТВО ПОЛЬЗОВАТЕЛЯ', font: 'Arial', size: 36, bold: true })]
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: 'Версия 1.0', font: 'Arial', size: 24, color: '888888' })]
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 2000 },
    children: [new TextRun({ text: '2026', font: 'Arial', size: 24, color: '888888' })]
  }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Table of contents
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 300 },
    children: [new TextRun({ text: 'Содержание', font: 'Arial', size: 32, bold: true })]
  }));
  children.push(new TableOfContents('Содержание', { hyperlink: true, headingStyleRange: '1-3' }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Process each section
  for (const sect of PAGE_ORDER) {
    sectionNum++;

    // Section heading (H1)
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 360, after: 200 },
      children: [new TextRun({ text: sectionNum + '. ' + sect.section, font: 'Arial', size: 30, bold: true })]
    }));

    for (const pagePath of sect.pages) {
      const fullPath = path.join(DOCS_DIR, pagePath);
      if (!fs.existsSync(fullPath)) {
        console.log('  ⚠ Missing: ' + pagePath);
        continue;
      }
      const md = fs.readFileSync(fullPath, 'utf-8');

      // Extract page title from first # heading
      const titleMatch = md.match(/^# (.+)/m);
      if (titleMatch && sect.pages.length > 1) {
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: cleanMd(titleMatch[1]), font: 'Arial', size: 26, bold: true })]
        }));
      }

      // Convert MD content to paragraphs
      const paras = mdToParas(md);
      children.push(...paras);
    }
  }

  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 30, bold: true, font: 'Arial' },
          paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, font: 'Arial' },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 24, bold: true, font: 'Arial' },
          paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
      ]
    },
    numbering: {
      config: [
        { reference: 'bullets',
          levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: 'numbers',
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ]
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1134, right: 850, bottom: 1134, left: 1701 } // ГОСТ: left 30mm, right 15mm, top/bottom 20mm
        }
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC', space: 4 } },
            children: [new TextRun({ text: 'rusNAS — Руководство пользователя', font: 'Arial', size: 16, color: '999999' })]
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Страница ', font: 'Arial', size: 16, color: '999999' }),
              new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: '999999' })
            ]
          })]
        })
      },
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join(OUT_DIR, 'RusNAS_Руководство_пользователя.docx');
  fs.writeFileSync(outPath, buffer);
  console.log('✓ DOCX: ' + outPath);
  console.log('  Size: ' + (buffer.length / 1024).toFixed(0) + ' KB');
}

build().catch(err => { console.error(err); process.exit(1); });
