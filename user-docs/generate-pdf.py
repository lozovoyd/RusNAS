#!/usr/bin/env python3
"""
Generate PDF user manual from user-docs markdown.
Concatenates all pages into single HTML, then converts to PDF via WeasyPrint.
"""
import os, sys, glob
from pathlib import Path

# Pages in order (matching mkdocs nav)
PAGES = [
    'index.md',
    'getting-started/first-login.md',
    'getting-started/interface.md',
    'getting-started/admin-access.md',
    'storage/shares.md',
    'storage/iscsi.md',
    'storage/worm.md',
    'storage/services.md',
    'storage/filebrowser.md',
    'raid/create.md',
    'raid/manage.md',
    'raid/replace.md',
    'raid/ssd-cache.md',
    'raid/backup-mode.md',
    'guard/overview.md',
    'guard/settings.md',
    'guard/events.md',
    'snapshots/manage.md',
    'snapshots/schedule.md',
    'snapshots/replication.md',
    'dedup/index.md',
    'ups/setup.md',
    'ups/monitoring.md',
    'network/interfaces.md',
    'network/dns-routes.md',
    'network/diagnostics.md',
    'analyzer/index.md',
    'performance/index.md',
    'ai/index.md',
    'containers/index.md',
    'users/index.md',
    'troubleshooting.md',
]

DOCS_DIR = Path(__file__).parent / 'docs'
OUT_DIR = Path(__file__).parent.parent / 'certification-docs'

try:
    import markdown
except ImportError:
    os.system(f'{sys.executable} -m pip install --break-system-packages markdown')
    import markdown

try:
    from weasyprint import HTML
except ImportError:
    print("ERROR: weasyprint not installed"); sys.exit(1)

def md_to_html(md_text):
    return markdown.markdown(md_text, extensions=['tables', 'fenced_code', 'toc'])

# Build combined HTML
html_parts = []
toc_items = []
section_num = 0

for page in PAGES:
    fpath = DOCS_DIR / page
    if not fpath.exists():
        print(f"  ⚠ Missing: {page}")
        continue
    md = fpath.read_text(encoding='utf-8')

    # Extract title
    for line in md.split('\n'):
        if line.startswith('# '):
            title = line[2:].strip()
            break
    else:
        title = page.replace('.md', '').replace('/', ' — ')

    section_num += 1
    anchor = f"section-{section_num}"
    toc_items.append((section_num, title, anchor))

    content_html = md_to_html(md)
    html_parts.append(f'<div class="page-section" id="{anchor}">')
    html_parts.append(content_html)
    html_parts.append('</div>')
    print(f"  ✓ [{section_num:02d}] {title}")

# Build TOC HTML
toc_html = '<div class="toc-page"><h1>Содержание</h1><ul class="toc-list">'
for num, title, anchor in toc_items:
    toc_html += f'<li><a href="#{anchor}">{num}. {title}</a></li>'
toc_html += '</ul></div>'

# Full document
full_html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
@page {{
    size: A4;
    margin: 20mm 15mm 20mm 30mm; /* ГОСТ: left 30mm */
    @top-right {{
        content: "rusNAS — Руководство пользователя";
        font-family: Arial, sans-serif;
        font-size: 8pt;
        color: #999;
    }}
    @bottom-center {{
        content: "Страница " counter(page) " из " counter(pages);
        font-family: Arial, sans-serif;
        font-size: 8pt;
        color: #999;
    }}
}}
@page:first {{
    @top-right {{ content: none; }}
    @bottom-center {{ content: none; }}
}}
body {{
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #222;
}}
h1 {{ font-size: 18pt; margin-top: 24pt; margin-bottom: 12pt; color: #111; page-break-after: avoid; }}
h2 {{ font-size: 14pt; margin-top: 18pt; margin-bottom: 8pt; color: #222; page-break-after: avoid; }}
h3 {{ font-size: 12pt; margin-top: 14pt; margin-bottom: 6pt; color: #333; page-break-after: avoid; }}
h4 {{ font-size: 11pt; font-weight: bold; margin-top: 10pt; margin-bottom: 4pt; }}
p {{ margin: 4pt 0; text-align: justify; }}
ul, ol {{ margin: 4pt 0; padding-left: 24pt; }}
li {{ margin: 2pt 0; }}
code {{
    font-family: 'Courier New', monospace;
    font-size: 9pt;
    background: #f5f5f5;
    padding: 1pt 3pt;
    border-radius: 2pt;
}}
pre {{
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 4pt;
    padding: 8pt;
    font-family: 'Courier New', monospace;
    font-size: 9pt;
    overflow-x: auto;
    page-break-inside: avoid;
}}
pre code {{
    background: none;
    padding: 0;
}}
table {{
    width: 100%;
    border-collapse: collapse;
    margin: 8pt 0;
    font-size: 10pt;
    page-break-inside: avoid;
}}
th, td {{
    border: 1px solid #ccc;
    padding: 4pt 8pt;
    text-align: left;
}}
th {{
    background: #e8e8e8;
    font-weight: bold;
}}
blockquote {{
    border-left: 3px solid #f5a623;
    margin: 8pt 0;
    padding: 4pt 12pt;
    background: #fffcf5;
    font-style: italic;
}}
.title-page {{
    text-align: center;
    padding-top: 200pt;
    page-break-after: always;
}}
.title-page h1 {{
    font-size: 36pt;
    color: #f5a623;
    margin-bottom: 8pt;
}}
.title-page .subtitle {{
    font-size: 14pt;
    color: #666;
    margin-bottom: 60pt;
}}
.title-page .doc-title {{
    font-size: 22pt;
    font-weight: bold;
    margin-bottom: 12pt;
}}
.title-page .version {{
    font-size: 12pt;
    color: #888;
}}
.title-page .year {{
    margin-top: 160pt;
    font-size: 12pt;
    color: #888;
}}
.toc-page {{
    page-break-after: always;
}}
.toc-page h1 {{
    font-size: 18pt;
    margin-bottom: 16pt;
}}
.toc-list {{
    list-style: none;
    padding: 0;
}}
.toc-list li {{
    margin: 4pt 0;
    font-size: 11pt;
}}
.toc-list a {{
    text-decoration: none;
    color: #222;
}}
.toc-list a::after {{
    content: leader(dotted) target-counter(attr(href), page);
    color: #888;
}}
.page-section {{
    page-break-before: auto;
}}
.page-section h1 {{
    border-bottom: 2px solid #f5a623;
    padding-bottom: 4pt;
}}
</style>
</head>
<body>

<div class="title-page">
    <h1>rusNAS</h1>
    <div class="subtitle">Сетевое хранилище данных корпоративного класса</div>
    <div class="doc-title">РУКОВОДСТВО ПОЛЬЗОВАТЕЛЯ</div>
    <div class="version">Версия 1.0</div>
    <div class="year">2026</div>
</div>

{toc_html}

{''.join(html_parts)}

</body>
</html>"""

# Write HTML for debugging
OUT_DIR.mkdir(parents=True, exist_ok=True)
html_path = OUT_DIR / 'RusNAS_Руководство_пользователя.html'
html_path.write_text(full_html, encoding='utf-8')
print(f"\n✓ HTML: {html_path}")

# Convert to PDF
pdf_path = OUT_DIR / 'RusNAS_Руководство_пользователя.pdf'
print(f"▸ Генерация PDF...")
HTML(string=full_html).write_pdf(str(pdf_path))
size_kb = pdf_path.stat().st_size / 1024
print(f"✓ PDF: {pdf_path} ({size_kb:.0f} KB)")
