/**
 * rusNAS Storage Analyzer — Frontend Logic
 * /usr/share/cockpit/rusnas/js/storage-analyzer.js
 */
'use strict';

// ─── FileBrowser URL helper ───────────────────────────────────────────────────
function getFileBrowserUrl(path, options) {
    const base = window.location.protocol + '//' + window.location.hostname + '/files/';
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (options && options.sort)  params.set('sort', options.sort);
    if (options && options.order) params.set('order', options.order);
    return base + (params.toString() ? '?' + params.toString() : '');
}

// ─── Constants ───────────────────────────────────────────────────────────────
const SA_API = '/usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py';

const FILE_TYPE_META = {
    video:   { label: 'Видео',       icon: '🎬', color: '#E53935' },
    photo:   { label: 'Фото',        icon: '📷', color: '#FB8C00' },
    docs:    { label: 'Документы',   icon: '📄', color: '#1E88E5' },
    archive: { label: 'Архивы',      icon: '📦', color: '#8E24AA' },
    backup:  { label: 'Бэкапы',      icon: '💾', color: '#00897B' },
    code:    { label: 'Код',         icon: '💻', color: '#43A047' },
    other:   { label: 'Прочее',      icon: '❓', color: '#757575' },
};

// ─── State ────────────────────────────────────────────────────────────────────
let activeTab     = 'overview';
let overviewData  = null;
let sharesData    = null;
let usersData     = null;
let filetypesData = null;
let chartPeriod   = 7;
let filePath      = '/';
let fileViewMode  = 'treemap'; // treemap | list
let scanRunning   = false;

// ─── Utility helpers ──────────────────────────────────────────────────────────
function fmtBytes(b) {
    if (b == null || isNaN(b)) return '—';
    const abs = Math.abs(b);
    if (abs >= 1e12) return (b / 1e12).toFixed(1) + ' ТБ';
    if (abs >= 1e9)  return (b / 1e9 ).toFixed(1) + ' ГБ';
    if (abs >= 1e6)  return (b / 1e6 ).toFixed(1) + ' МБ';
    if (abs >= 1e3)  return (b / 1e3 ).toFixed(0) + ' КБ';
    return b + ' Б';
}

function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(ts) {
    if (!ts) return '—';
    const sec = Math.floor(Date.now() / 1000) - ts;
    if (sec < 60)   return 'только что';
    if (sec < 3600) return Math.floor(sec / 60) + ' мин. назад';
    if (sec < 86400) return Math.floor(sec / 3600) + ' ч. назад';
    return Math.floor(sec / 86400) + ' дн. назад';
}

function fmtDays(d) {
    if (d == null) return 'нет данных';
    if (d > 365) return '>1 года';
    return d + ' дн.';
}

function barColor(pct) {
    if (pct >= 95) return 'var(--danger)';
    if (pct >= 85) return '#FF6F00';
    if (pct >= 70) return 'var(--warning)';
    return 'var(--success)';
}

function safeJson(str) {
    try { return JSON.parse(str); } catch { return null; }
}

// ─── API calls via cockpit.spawn ──────────────────────────────────────────────
function saApi(args) {
    return new Promise((resolve, reject) => {
        let out = '';
        const proc = cockpit.spawn(
            ['sudo', '-n', 'python3', SA_API].concat(args),
            { err: 'message', superuser: 'try' }
        );
        proc.stream(chunk => { out += chunk; });
        proc.done(() => {
            const data = safeJson(out);
            if (!data)  { reject('Invalid JSON from API'); return; }
            if (data.error) { reject(data.error); return; }
            resolve(data);
        });
        proc.fail(err => reject(err));
    });
}

// ─── Tab switching ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#saTabs a[data-tab]').forEach(a => {
        a.addEventListener('click', e => {
            e.preventDefault();
            switchTab(a.dataset.tab);
        });
    });

    // Period buttons (chart)
    document.querySelectorAll('.sa-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sa-period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            chartPeriod = parseInt(btn.dataset.days);
            if (overviewData) renderFillChart(overviewData);
        });
    });

    // Scan now
    document.getElementById('btnScanNow').addEventListener('click', startScan);

    // Settings modal
    document.getElementById('btnSettings').addEventListener('click', () => {
        const m = document.getElementById('settingsModal');
        m.style.display = 'flex';
        m.classList.add('in');
    });
    document.querySelectorAll('[data-dismiss="modal"]').forEach(btn => {
        btn.addEventListener('click', closeModal);
    });
    document.getElementById('btnSaveSettings').addEventListener('click', () => {
        closeModal();
        cockpit.notification.show('Настройки сохранены');
    });
    document.getElementById('settingSchedule').addEventListener('change', function() {
        document.getElementById('settingDailyTimeGroup').style.display =
            this.value === 'daily' ? '' : 'none';
    });

    // File view toggle
    document.getElementById('btnViewTreemap').addEventListener('click', () => {
        fileViewMode = 'treemap';
        document.getElementById('btnViewTreemap').classList.add('active');
        document.getElementById('btnViewList').classList.remove('active');
        document.getElementById('treemapView').style.display = '';
        document.getElementById('listView').style.display = 'none';
    });
    document.getElementById('btnViewList').addEventListener('click', () => {
        fileViewMode = 'list';
        document.getElementById('btnViewList').classList.add('active');
        document.getElementById('btnViewTreemap').classList.remove('active');
        document.getElementById('listView').style.display = '';
        document.getElementById('treemapView').style.display = 'none';
    });

    // File filters
    document.getElementById('filterFiletype').addEventListener('change', loadFiles);
    document.getElementById('filterOlderThan').addEventListener('change', loadFiles);
    document.getElementById('filterSort').addEventListener('change', loadFiles);

    // Shares period
    document.getElementById('sharesPeriod').addEventListener('change', loadShares);

    // Start
    switchTab('overview');
    loadScanStatus();
});

function closeModal() {
    const m = document.getElementById('settingsModal');
    m.classList.remove('in');
    setTimeout(() => { m.style.display = 'none'; }, 300);
}

function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('#saTabs li').forEach(li => li.classList.remove('active'));
    document.querySelectorAll('#saTabs a[data-tab]').forEach(a => {
        if (a.dataset.tab === tab) a.parentElement.classList.add('active');
    });
    document.querySelectorAll('.sa-tab-content').forEach(d => d.style.display = 'none');
    const el = document.getElementById('tab-' + tab);
    if (el) el.style.display = '';

    if (tab === 'overview' && !overviewData) loadOverview();
    if (tab === 'shares')                    loadShares();
    if (tab === 'files')                     { autoSetFilePath(); loadFiles(); }
    if (tab === 'users'  && !usersData)      loadUsers();
    if (tab === 'filetypes' && !filetypesData) loadFiletypes();
}

// ─── SCAN STATUS / HEADER ────────────────────────────────────────────────────
function loadScanStatus() {
    saApi(['scan-status']).then(data => {
        const ageEl  = document.getElementById('scanAge');
        const durEl  = document.getElementById('scanDuration');
        const ts     = data.last_scan_ts;

        if (!ts) {
            ageEl.textContent = 'Сканирование не выполнялось';
        } else {
            const age = data.last_scan_age_seconds || 0;
            let cls = '';
            if (age > 86400 * 2) cls = 'sa-scan-stale-red';
            else if (age > 86400) cls = 'sa-scan-stale-yellow';
            ageEl.textContent = 'Последнее: ' + fmtAgo(ts);
            ageEl.className = 'sa-scan-age ' + cls;
        }

        if (data.status === 'running') {
            setScanning(true);
        }
    }).catch(() => {
        document.getElementById('scanAge').textContent = 'Нет данных';
    });
}

function setScanning(on) {
    scanRunning = on;
    const btn = document.getElementById('btnScanNow');
    const bar = document.getElementById('scanProgress');
    btn.disabled = on;
    btn.textContent = on ? '⏳ Сканирование...' : '🔄 Сканировать сейчас';
    bar.style.display = on ? '' : 'none';
    if (on) {
        let w = 5;
        const iv = setInterval(() => {
            w = Math.min(w + Math.random() * 3, 90);
            document.getElementById('scanProgressBar').style.width = w + '%';
            if (!scanRunning) { clearInterval(iv); }
        }, 800);
    }
}

function startScan() {
    if (scanRunning) return;
    setScanning(true);
    document.getElementById('scanProgressLabel').textContent = 'Сканирование...';
    saApi(['scan-now']).then(data => {
        setScanning(false);
        document.getElementById('scanProgressBar').style.width = '100%';
        // Reload all tabs
        overviewData = null; sharesData = null; usersData = null; filetypesData = null;
        loadScanStatus();
        if (activeTab === 'overview')   loadOverview();
        if (activeTab === 'shares')     loadShares();
        if (activeTab === 'users')      loadUsers();
        if (activeTab === 'filetypes')  loadFiletypes();
    }).catch(err => {
        setScanning(false);
        document.getElementById('scanProgressLabel').textContent = 'Ошибка: ' + err;
    });
}

// ─── TAB 1: OVERVIEW ─────────────────────────────────────────────────────────
function loadOverview() {
    saApi(['overview']).then(data => {
        overviewData = data;
        renderOverviewCards(data);
        renderVolumeMap(data.volumes || []);
        renderFillChart(data);
        renderTopConsumers(data.top_consumers || []);
        // Update scan age from fresh data
        if (data.last_scan) {
            const ageEl = document.getElementById('scanAge');
            ageEl.textContent = 'Последнее: ' + fmtAgo(data.last_scan);
        }
        if (data.scan_duration) {
            document.getElementById('scanDuration').textContent = 'Время сканирования: ' + data.scan_duration + ' с';
        }
    }).catch(err => {
        document.getElementById('volumesGrid').innerHTML =
            '<div class="sa-error">Ошибка загрузки: ' + err + '</div>';
    });
}

function renderOverviewCards(data) {
    const vols = data.volumes || [];
    let total = 0, used = 0, free = 0;
    vols.forEach(v => { total += v.total || 0; used += v.used || 0; free += v.free || 0; });
    const pct = total ? Math.round(used * 100 / total) : 0;

    document.getElementById('valTotal').textContent = fmtBytes(total);
    document.getElementById('valUsed').textContent  = fmtBytes(used) + ' (' + pct + '%)';
    document.getElementById('valFree').textContent  = fmtBytes(free);

    const barU = document.getElementById('barUsed');
    barU.style.width = pct + '%';
    barU.style.background = barColor(pct);

    const barF = document.getElementById('barFree');
    barF.style.width = (100 - pct) + '%';

    document.getElementById('subUsed').textContent = pct >= 95 ? '⚠️ Критично!'
        : pct >= 85 ? '⚠️ Мало места' : '';

    // Forecasts
    const fc = data.forecasts || {};
    // Aggregate across volumes: pick min days
    let fc24h = null, fc7d = null, fc30d = null;
    Object.values(fc).forEach(f => {
        if (f.days_7d  != null && (fc7d  == null || f.days_7d  < fc7d))  fc7d  = f.days_7d;
        if (f.days_30d != null && (fc30d == null || f.days_30d < fc30d)) fc30d = f.days_30d;
    });

    function fcHtml(d) {
        if (d == null) return '<span class="sa-fc-nodata">нет данных</span>';
        const cls = d < 7 ? 'sa-fc-critical' : d < 30 ? 'sa-fc-warn' : 'sa-fc-ok';
        return '<span class="' + cls + '">' + fmtDays(d) + '</span>';
    }
    document.getElementById('fc24h').innerHTML = '<span class="sa-fc-nodata">нет данных</span>';
    document.getElementById('fc7d').innerHTML  = fcHtml(fc7d);
    document.getElementById('fc30d').innerHTML = fcHtml(fc30d);
}

function renderVolumeMap(volumes) {
    const grid = document.getElementById('volumesGrid');
    if (!volumes.length) {
        grid.innerHTML = '<div class="sa-empty">Тома не найдены. Проверьте монтирование /mnt/* /volume/* /data/*</div>';
        return;
    }
    grid.innerHTML = '';
    volumes.forEach(v => {
        const pct = v.pct || 0;
        const card = document.createElement('div');
        card.className = 'sa-vol-card';
        card.innerHTML = `
            <div class="sa-vol-name">${v.path}</div>
            <div class="sa-vol-meta">${v.device} &nbsp;•&nbsp; ${v.fs}</div>
            <div class="sa-vol-bar-wrap">
                <div class="sa-vol-bar" style="width:${pct}%;background:${barColor(pct)}"></div>
            </div>
            <div class="sa-vol-sizes">
                <span>${fmtBytes(v.used)} / ${fmtBytes(v.total)}</span>
                <span class="sa-vol-pct" style="color:${barColor(pct)}">${pct}%</span>
            </div>
        `;
        card.addEventListener('click', () => {
            filePath = v.path;
            switchTab('files');
        });
        grid.appendChild(card);
    });
}

function renderFillChart(data) {
    const wrap = document.getElementById('fillChartWrap');
    const vols  = data.volumes || [];
    if (!vols.length) { wrap.innerHTML = '<div class="sa-empty">Нет данных</div>'; return; }

    // Merge history from all volumes, pick first volume with history
    let history = [];
    for (const v of vols) {
        if (v.history && v.history.length > 1) { history = v.history; break; }
    }

    const W = wrap.clientWidth || 600, H = 180;
    const pad = { top: 16, right: 80, bottom: 36, left: 50 };
    const iW = W - pad.left - pad.right;
    const iH = H - pad.top - pad.bottom;

    const now = Date.now() / 1000;
    const cutoff = now - chartPeriod * 86400;
    const pts = history.filter(h => h.ts >= cutoff);

    if (pts.length < 2) {
        wrap.innerHTML = '<div class="sa-empty">Недостаточно исторических данных. Данные появятся после нескольких циклов сканирования.</div>';
        return;
    }

    // Find total for % calc
    const vol = vols[0];
    const totalBytes = vol.total || 1;

    const tsMin = pts[0].ts, tsMax = pts[pts.length - 1].ts;
    const tsForecast = tsMax + Math.ceil(chartPeriod / 3) * 86400;
    const tsRange = Math.max(tsForecast - tsMin, 86400);
    const yMin = 0, yMax = 100;

    function tx(ts) { return pad.left + ((ts - tsMin) / tsRange) * iW; }
    function ty(pct) { return pad.top + (1 - pct / 100) * iH; }

    // Build actual line
    const actualPath = pts.map((p, i) => {
        const pct = (p.used / totalBytes) * 100;
        return (i === 0 ? 'M' : 'L') + tx(p.ts).toFixed(1) + ',' + ty(pct).toFixed(1);
    }).join(' ');

    // Forecast line (linear extrapolation)
    let forecastPath = '';
    const fc = data.forecasts || {};
    const volFc = Object.values(fc)[0] || {};
    if (volFc.days_7d != null) {
        const curPct  = (vol.used / totalBytes) * 100;
        const endPct  = Math.min(100, curPct + (100 - curPct) * (chartPeriod / (3 * volFc.days_7d)));
        const fcStart = pts[pts.length - 1].ts;
        const fcEnd   = fcStart + Math.ceil(chartPeriod / 3) * 86400;
        forecastPath = `M${tx(fcStart).toFixed(1)},${ty(curPct).toFixed(1)} L${tx(fcEnd).toFixed(1)},${ty(endPct).toFixed(1)}`;
    }

    // Axis labels X
    let xLabels = '';
    const labelCount = Math.min(6, pts.length);
    for (let i = 0; i < labelCount; i++) {
        const pt = pts[Math.floor(i * (pts.length - 1) / (labelCount - 1))];
        const d = new Date(pt.ts * 1000);
        const label = (d.getDate()) + '.' + String(d.getMonth() + 1).padStart(2, '0');
        xLabels += `<text x="${tx(pt.ts).toFixed(1)}" y="${H - 6}" class="sa-chart-label" text-anchor="middle">${label}</text>`;
    }

    // Axis labels Y
    let yLabels = '';
    [0, 25, 50, 75, 95, 100].forEach(pct => {
        const y = ty(pct).toFixed(1);
        yLabels += `<text x="${pad.left - 6}" y="${y}" class="sa-chart-label" text-anchor="end" dominant-baseline="middle">${pct}%</text>`;
        yLabels += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + iW}" y2="${y}" class="sa-chart-grid" ${pct === 95 ? 'stroke="#E53935" stroke-dasharray="4,3"' : ''}/>`;
    });

    wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="sa-fill-chart">
      ${yLabels}
      ${xLabels}
      <path d="${actualPath}" fill="none" stroke="var(--primary,#2196f3)" stroke-width="2"/>
      ${forecastPath ? `<path d="${forecastPath}" fill="none" stroke="#FF9800" stroke-width="2" stroke-dasharray="6,4"/>` : ''}
      <line x1="${tx(now).toFixed(1)}" y1="${pad.top}" x2="${tx(now).toFixed(1)}" y2="${pad.top + iH}" stroke="var(--color-muted,#888)" stroke-dasharray="3,3" stroke-width="1"/>
      <text x="${(tx(now) + 4).toFixed(1)}" y="${(pad.top + 12).toFixed(1)}" class="sa-chart-label" fill="var(--color-muted,#888)">сейчас</text>
      ${forecastPath ? '<text x="' + (W - 4) + '" y="' + (pad.top + 12) + '" class="sa-chart-label" text-anchor="end" fill="#FF9800">прогноз →</text>' : ''}
    </svg>`;
}

function renderTopConsumers(consumers) {
    const wrap = document.getElementById('topConsumers');
    if (!consumers.length) {
        wrap.innerHTML = '<div class="sa-empty">Нет данных о потребителях. Дождитесь первого сканирования.</div>';
        return;
    }
    let html = '<div class="sa-top-list">';
    consumers.forEach((c, i) => {
        const meta = FILE_TYPE_META[c.type] || FILE_TYPE_META.other;
        html += `<div class="sa-top-item">
            <span class="sa-top-rank">${i + 1}</span>
            <span class="sa-top-icon">${meta.icon}</span>
            <div class="sa-top-info">
                <span class="sa-top-name">${c.name || c.path || '—'}</span>
                <span class="sa-top-path">${c.path || ''}</span>
            </div>
            <span class="sa-top-size">${fmtBytes(c.used_bytes)}</span>
            <a class="btn btn-default btn-xs" href="${getFileBrowserUrl(c.path || '/', {sort:'size', order:'desc'})}" target="_blank">📂 Открыть</a>
        </div>`;
    });
    html += '</div>';
    wrap.innerHTML = html;

}

// ─── TAB 2: SHARES ───────────────────────────────────────────────────────────
function loadShares() {
    const period = document.getElementById('sharesPeriod').value;
    const tbody  = document.getElementById('sharesTbody');
    tbody.innerHTML = '<tr><td colspan="6" class="sa-loading"><div class="sa-spinner"></div></td></tr>';

    saApi(['shares', period]).then(data => {
        sharesData = data;
        renderSharesTable(data.shares || []);
    }).catch(err => {
        tbody.innerHTML = '<tr><td colspan="6" class="sa-error">Ошибка: ' + err + '</td></tr>';
    });
}

function renderSharesTable(shares) {
    const tbody = document.getElementById('sharesTbody');
    const alertEl = document.getElementById('sharesForecastAlert');

    if (!shares.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="sa-empty">Шары не найдены. Проверьте /etc/samba/smb.conf</td></tr>';
        return;
    }

    // Find urgent forecasts
    const urgent = shares.filter(s => s.forecast_days != null && s.forecast_days < 30);
    if (urgent.length) {
        const u = urgent[0];
        alertEl.style.display = '';
        alertEl.innerHTML = `⚠️ <b>${u.name}</b> заполнится через ~<b>${u.forecast_days} дн.</b> (≈${forecastDate(u.forecast_days)}) при скорости ${fmtBytes(u.growth_per_day)}/день`;
    } else {
        alertEl.style.display = 'none';
    }

    tbody.innerHTML = '';
    shares.forEach(s => {
        const gpd     = s.growth_per_day || 0;
        const gpdStr  = gpd === 0 ? '—' : (gpd > 0 ? '+' : '') + fmtBytes(gpd) + '/день';
        const change  = s.history && s.history.length >= 2
            ? s.history[s.history.length - 1].bytes - s.history[0].bytes
            : null;
        const chgStr  = change == null ? '—'
            : (change >= 0 ? '+' : '') + fmtBytes(change);
        const chgCls  = change == null ? '' : change > 0 ? 'sa-delta-up' : change < 0 ? 'sa-delta-down' : '';

        const tr = document.createElement('tr');
        tr.className = 'sa-share-row';
        tr.dataset.name = s.name;
        tr.innerHTML = `
            <td><strong>${s.name}</strong></td>
            <td class="sa-path-cell">${s.path || '—'}</td>
            <td>${fmtBytes(s.used_bytes)}</td>
            <td class="${chgCls}">${chgStr}</td>
            <td>${gpdStr}</td>
            <td><button class="btn btn-default btn-xs sa-share-expand-btn" data-name="${s.name}">▶ Детали</button></td>
        `;
        tbody.appendChild(tr);

        // Detail row (hidden)
        const detailTr = document.createElement('tr');
        detailTr.className = 'sa-share-detail-row';
        detailTr.id = 'detail-' + s.name;
        detailTr.style.display = 'none';
        detailTr.innerHTML = '<td colspan="6"><div class="sa-share-detail" id="detail-content-' + s.name + '"></div></td>';
        tbody.appendChild(detailTr);
    });

    // Expand handlers
    tbody.querySelectorAll('.sa-share-expand-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleShareDetail(btn.dataset.name, btn));
    });
}

function toggleShareDetail(name, btn) {
    const row = document.getElementById('detail-' + name);
    const expanded = row.style.display !== 'none';
    if (expanded) {
        row.style.display = 'none';
        btn.textContent = '▶ Детали';
        return;
    }
    row.style.display = '';
    btn.textContent = '▼ Скрыть';

    const share = (sharesData.shares || []).find(s => s.name === name);
    if (!share) return;
    const el = document.getElementById('detail-content-' + name);

    // Mini sparkline SVG
    const hist = share.history || [];
    let sparkHtml = '';
    if (hist.length >= 2) {
        sparkHtml = buildSparkline(hist.map(h => h.bytes), 300, 60);
    }

    const fcStr = share.forecast_days != null
        ? `Прогноз: хватит ещё ~<b>${share.forecast_days} дн.</b> (при скорости ${fmtBytes(share.growth_per_day)}/день)`
        : 'Прогноз недостаточно данных';

    el.innerHTML = `
        <div class="sa-detail-chart">${sparkHtml || '<span class="sa-empty">Нет истории</span>'}</div>
        <div class="sa-detail-forecast">${fcStr}</div>
        <div class="sa-detail-actions">
            <a class="btn btn-default btn-sm" href="${getFileBrowserUrl(share.path)}" target="_blank">📂 Открыть в FileBrowser</a>
        </div>`;

}

function forecastDate(days) {
    const d = new Date(Date.now() + days * 86400000);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// ─── TAB 3: FILES ─────────────────────────────────────────────────────────────
// If filePath is still '/', replace it with the first known volume mount point.
// Uses overviewData if already loaded, otherwise falls back to a quick API call.
function autoSetFilePath() {
    if (filePath !== '/') return;
    const vols = overviewData && overviewData.volumes;
    if (vols && vols.length > 0) {
        filePath = vols[0].path;
        return;
    }
    // overviewData not yet loaded — fetch volumes synchronously-ish
    saApi(['overview']).then(data => {
        overviewData = data;
        if (data.volumes && data.volumes.length > 0 && filePath === '/') {
            filePath = data.volumes[0].path;
            loadFiles();
        }
    }).catch(() => {});
}

function loadFiles() {
    const ftype   = document.getElementById('filterFiletype').value;
    const older   = document.getElementById('filterOlderThan').value;
    const sort    = document.getElementById('filterSort').value;

    updateBreadcrumb(filePath);

    if (fileViewMode === 'treemap') {
        loadTreemap(filePath, ftype, older, sort);
    } else {
        loadFileList(filePath, ftype, older, sort);
    }
}

function updateBreadcrumb(path) {
    const bc = document.getElementById('fileBreadcrumb');
    bc.innerHTML = '';
    const parts = path === '/' ? [''] : path.split('/');
    let cur = '';
    parts.forEach((p, i) => {
        if (i === 0) {
            const span = document.createElement('span');
            span.className = 'sa-bc-item';
            span.textContent = '/';
            span.dataset.path = '/';
            span.addEventListener('click', () => navigateTo('/'));
            bc.appendChild(span);
        } else {
            cur += '/' + p;
            const sep = document.createElement('span');
            sep.className = 'sa-bc-sep';
            sep.textContent = ' › ';
            bc.appendChild(sep);
            const span = document.createElement('span');
            span.className = 'sa-bc-item' + (i === parts.length - 1 ? ' sa-bc-active' : '');
            span.textContent = p;
            span.dataset.path = cur;
            const pathCapture = cur;
            span.addEventListener('click', () => navigateTo(pathCapture));
            bc.appendChild(span);
        }
    });
}

function navigateTo(path) {
    filePath = path;
    loadFiles();
}

function loadTreemap(path, ftype, older, sort) {
    const wrap = document.getElementById('treemapWrap');
    wrap.innerHTML = '<div class="sa-loading"><div class="sa-spinner"></div> Загрузка...</div>';

    saApi(['files', path, sort, ftype, older]).then(data => {
        if (!data.entries || !data.entries.length) {
            wrap.innerHTML = '<div class="sa-empty">Нет данных или папка пуста</div>';
            return;
        }
        renderTreemap(data.entries, wrap);
    }).catch(err => {
        wrap.innerHTML = '<div class="sa-error">Ошибка: ' + err + '</div>';
    });
}

function loadFileList(path, ftype, older, sort) {
    const tbody = document.getElementById('fileListTbody');
    tbody.innerHTML = '<tr><td colspan="5" class="sa-loading"><div class="sa-spinner"></div></td></tr>';

    saApi(['files', path, sort, ftype, older]).then(data => {
        renderFileList(data.entries || [], tbody, path);
    }).catch(err => {
        tbody.innerHTML = '<tr><td colspan="5" class="sa-error">Ошибка: ' + err + '</td></tr>';
    });
}

function renderFileList(entries, tbody, path) {
    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="sa-empty">Нет файлов</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    entries.forEach(e => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${e.type === 'dir' ? '📁' : '📄'} ${e.name}</td>
            <td>${e.type === 'dir' ? 'Папка' : 'Файл'}</td>
            <td>${fmtBytes(e.bytes)}</td>
            <td>${e.files != null ? e.files.toLocaleString('ru') : '—'}</td>
            <td>${fmtAgo(e.mtime)}</td>
        `;
        if (e.type === 'dir') {
            tr.style.cursor = 'pointer';
            const newPath = (path === '/' ? '' : path) + '/' + e.name;
            tr.addEventListener('click', () => navigateTo(newPath));
        }
        tbody.appendChild(tr);
    });
}

// ─── TREEMAP ─────────────────────────────────────────────────────────────────
const TYPE_COLORS = {
    dir: '#455A64', file: '#607D8B',
    video: '#E53935', photo: '#FB8C00', docs: '#1E88E5',
    archive: '#8E24AA', backup: '#00897B', code: '#43A047', other: '#757575',
};

function guessColor(entry) {
    if (entry.type === 'dir') return '#37474F';
    const ext = entry.name.split('.').pop().toLowerCase();
    const VIDEO = ['mp4','mkv','avi','mov','wmv','ts','m2ts','webm'];
    const PHOTO = ['jpg','jpeg','png','raw','cr2','nef','heic','tiff','bmp'];
    const DOCS  = ['pdf','doc','docx','xls','xlsx','odt','ods','ppt','pptx','txt'];
    const ARC   = ['zip','tar','gz','bz2','7z','rar','iso','xz'];
    const BAK   = ['img','bak','bkp','backup','dump','sql'];
    const CODE  = ['py','js','ts','go','rs','java','c','cpp','h','sh','rb','php'];
    if (VIDEO.includes(ext)) return '#E53935';
    if (PHOTO.includes(ext)) return '#FB8C00';
    if (DOCS .includes(ext)) return '#1E88E5';
    if (ARC  .includes(ext)) return '#8E24AA';
    if (BAK  .includes(ext)) return '#00897B';
    if (CODE .includes(ext)) return '#43A047';
    return '#546E7A';
}

function squarify(items, x, y, w, h) {
    if (!items.length) return [];
    if (items.length === 1) {
        return [Object.assign({}, items[0], { x, y, w, h })];
    }

    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return [];

    const results = [];
    squarifyRow(items, x, y, w, h, total, results);
    return results;
}

function squarifyRow(items, x, y, w, h, total, results) {
    if (!items.length) return;
    if (items.length === 1) {
        results.push(Object.assign({}, items[0], { x, y, w, h }));
        return;
    }

    // Find best row
    const isWide = w >= h;
    let rowItems = [];
    let rowTotal = 0;
    let bestRatio = Infinity;

    for (let i = 0; i < items.length; i++) {
        rowItems.push(items[i]);
        rowTotal += items[i].value;
        const ratio = worstRatio(rowItems, rowTotal, isWide ? h : w, w, h, total);
        if (ratio > bestRatio) {
            rowItems.pop();
            rowTotal -= items[i].value;
            break;
        }
        bestRatio = ratio;
    }

    // Place row items
    const rowFrac = rowTotal / total;
    let offset = 0;
    rowItems.forEach(item => {
        const frac  = item.value / rowTotal;
        if (isWide) {
            const rw = w * rowFrac;
            const rh = h * frac;
            results.push(Object.assign({}, item, { x: x + w - rw, y: y + offset, w: rw, h: rh }));
            offset += rh;
        } else {
            const rw = w * frac;
            const rh = h * rowFrac;
            results.push(Object.assign({}, item, { x: x + offset, y, w: rw, h: rh }));
            offset += rw;
        }
    });

    // Recurse for remaining
    const remaining = items.slice(rowItems.length);
    const remTotal  = total - rowTotal;
    if (!remaining.length || !remTotal) return;
    if (isWide) {
        squarifyRow(remaining, x, y, w * (1 - rowFrac), h, remTotal, results);
    } else {
        squarifyRow(remaining, x, y + h * rowFrac, w, h * (1 - rowFrac), remTotal, results);
    }
}

function worstRatio(row, rowTotal, shorter, w, h, total) {
    const area  = (rowTotal / total) * w * h;
    const side  = shorter;
    let worst = 0;
    row.forEach(item => {
        const s = (item.value / rowTotal) * area / side;
        const r = Math.max(side / s, s / side);
        if (r > worst) worst = r;
    });
    return worst;
}

function renderTreemap(entries, wrap) {
    wrap.innerHTML = '';
    const W = wrap.clientWidth  || 600;
    const H = Math.max(300, Math.min(450, Math.round(W * 0.55)));

    const items = entries
        .filter(e => e.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 50)
        .map(e => ({ label: e.name, value: e.bytes, entry: e, color: guessColor(e) }));

    if (!items.length) {
        wrap.innerHTML = '<div class="sa-empty">Нет данных</div>';
        return;
    }

    const rects = squarify(items, 0, 0, W, H);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.style.display = 'block';

    const tooltip = document.getElementById('treemapTooltip');

    rects.forEach(rect => {
        if (rect.w < 2 || rect.h < 2) return;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.style.cursor = rect.entry.type === 'dir' ? 'pointer' : 'default';

        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x',      (rect.x + 1).toFixed(1));
        r.setAttribute('y',      (rect.y + 1).toFixed(1));
        r.setAttribute('width',  Math.max(0, rect.w - 2).toFixed(1));
        r.setAttribute('height', Math.max(0, rect.h - 2).toFixed(1));
        r.setAttribute('fill',   rect.color);
        r.setAttribute('rx',     '3');
        g.appendChild(r);

        // Label
        if (rect.w > 60 && rect.h > 30) {
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', (rect.x + rect.w / 2).toFixed(1));
            text.setAttribute('y', (rect.y + rect.h / 2 - (rect.h > 50 ? 8 : 0)).toFixed(1));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'middle');
            text.setAttribute('fill', '#fff');
            text.setAttribute('font-size', Math.min(13, rect.w / 8).toFixed(0));
            text.setAttribute('font-weight', '600');
            text.setAttribute('pointer-events', 'none');
            // Clip name if too long
            const maxChars = Math.floor(rect.w / 8);
            const name = rect.label.length > maxChars ? rect.label.slice(0, maxChars - 1) + '…' : rect.label;
            text.textContent = name;
            g.appendChild(text);

            if (rect.h > 50) {
                const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                sub.setAttribute('x', (rect.x + rect.w / 2).toFixed(1));
                sub.setAttribute('y', (rect.y + rect.h / 2 + 10).toFixed(1));
                sub.setAttribute('text-anchor', 'middle');
                sub.setAttribute('dominant-baseline', 'middle');
                sub.setAttribute('fill', 'rgba(255,255,255,0.75)');
                sub.setAttribute('font-size', '11');
                sub.setAttribute('pointer-events', 'none');
                sub.textContent = fmtBytes(rect.entry.bytes);
                g.appendChild(sub);
            }
        }

        // Events
        g.addEventListener('mouseenter', e => {
            r.setAttribute('opacity', '0.85');
            tooltip.style.display = '';
            tooltip.innerHTML = `<b>${rect.label}</b><br>${fmtBytes(rect.entry.bytes)}` +
                (rect.entry.files != null ? `<br>${rect.entry.files.toLocaleString('ru')} файл(ов)` : '') +
                `<br>Изм.: ${fmtAgo(rect.entry.mtime)}`;
        });
        g.addEventListener('mousemove', e => {
            const bRect = wrap.getBoundingClientRect();
            tooltip.style.left = (e.clientX - bRect.left + 12) + 'px';
            tooltip.style.top  = (e.clientY - bRect.top  + 12) + 'px';
        });
        g.addEventListener('mouseleave', () => {
            r.setAttribute('opacity', '1');
            tooltip.style.display = 'none';
        });
        if (rect.entry.type === 'dir') {
            g.addEventListener('click', () => {
                const newPath = (filePath === '/' ? '' : filePath) + '/' + rect.label;
                navigateTo(newPath);
            });
        }

        svg.appendChild(g);
    });

    wrap.appendChild(svg);
}

// ─── TAB 4: USERS ─────────────────────────────────────────────────────────────
function loadUsers() {
    const tbody = document.getElementById('usersTbody');
    tbody.innerHTML = '<tr><td colspan="6" class="sa-loading"><div class="sa-spinner"></div></td></tr>';

    saApi(['users']).then(data => {
        usersData = data;
        renderUsersTable(data.users || []);
    }).catch(err => {
        tbody.innerHTML = '<tr><td colspan="6" class="sa-error">Ошибка: ' + err + '</td></tr>';
    });
}

function renderUsersTable(users) {
    const tbody = document.getElementById('usersTbody');
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="sa-empty">Пользователи не найдены (UID 1000–60000)</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    users.forEach(u => {
        const quota = u.quota_bytes;
        const pct   = quota ? Math.round(u.used_bytes * 100 / quota) : null;
        const gpd   = u.growth_per_day;
        const hist  = u.history || [];
        const change = hist.length >= 2 ? hist[hist.length - 1].bytes - hist[0].bytes : null;

        let quotaHtml;
        if (!quota) {
            quotaHtml = '<span class="sa-muted">нет квоты</span>';
        } else {
            const cls = pct >= 95 ? 'sa-quota-critical' : pct >= 80 ? 'sa-quota-warn' : '';
            quotaHtml = `<div class="sa-quota-bar-wrap"><div class="sa-quota-bar ${cls}" style="width:${pct}%"></div></div> ${pct}%`;
        }

        const chgStr = change == null ? '—' : (change >= 0 ? '+' : '') + fmtBytes(change);
        const chgCls = change == null ? '' : change > 0 ? 'sa-delta-up' : change < 0 ? 'sa-delta-down' : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${u.username}</strong></td>
            <td class="sa-path-cell">${u.home || '—'}</td>
            <td>${fmtBytes(u.used_bytes)}</td>
            <td>${fmtBytes(quota)}</td>
            <td>${quotaHtml}</td>
            <td class="${chgCls}">${chgStr}</td>
        `;
        if (pct >= 95) tr.classList.add('sa-row-critical');
        tbody.appendChild(tr);
    });
}

// ─── TAB 5: FILE TYPES ───────────────────────────────────────────────────────
function loadFiletypes() {
    const tbody = document.getElementById('filetypesTbody');
    tbody.innerHTML = '<tr><td colspan="5" class="sa-loading"><div class="sa-spinner"></div></td></tr>';

    saApi(['filetypes']).then(data => {
        filetypesData = data;
        renderFiletypes(data.breakdown || []);
    }).catch(err => {
        tbody.innerHTML = '<tr><td colspan="5" class="sa-error">Ошибка: ' + err + '</td></tr>';
    });
}

function renderFiletypes(breakdown) {
    const tbody = document.getElementById('filetypesTbody');
    const svg   = document.getElementById('donutSvg');

    const total = breakdown.reduce((s, f) => s + (f.bytes || 0), 0);
    document.getElementById('donutTotalVal').textContent = fmtBytes(total);

    // Donut chart
    if (breakdown.length) {
        renderDonut(svg, breakdown, total);
    }

    // Table
    if (!breakdown.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="sa-empty">Нет данных</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    breakdown.forEach(f => {
        const pct = total ? Math.round(f.bytes * 100 / total) : 0;
        const ch  = f.change_7d;
        const chStr = ch == null || ch === 0 ? '—' : (ch > 0 ? '+' : '') + fmtBytes(ch);
        const chCls = ch == null ? '' : ch > 0 ? 'sa-delta-up' : ch < 0 ? 'sa-delta-down' : '';
        const meta = FILE_TYPE_META[f.type] || FILE_TYPE_META.other;

        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.innerHTML = `
            <td><span style="color:${f.color || meta.color};font-size:1.2em">${meta.icon}</span> ${meta.label}</td>
            <td>${(f.count || 0).toLocaleString('ru')}</td>
            <td>${fmtBytes(f.bytes)}</td>
            <td>${pct}%</td>
            <td class="${chCls}">${chStr}</td>
        `;
        tr.addEventListener('click', () => {
            document.getElementById('filterFiletype').value = f.type;
            filePath = '/';
            switchTab('files');
        });
        tbody.appendChild(tr);
    });
}

function renderDonut(svg, breakdown, total) {
    svg.innerHTML = '';
    const cx = 110, cy = 110, R = 85, r = 55;
    const gap = 0.02;
    let angle = -Math.PI / 2;

    breakdown.forEach(f => {
        if (!f.bytes || !total) return;
        const frac  = f.bytes / total;
        const sweep = frac * Math.PI * 2 - gap;
        if (sweep <= 0) return;
        const meta = FILE_TYPE_META[f.type] || FILE_TYPE_META.other;
        const color = f.color || meta.color;

        const x1 = cx + R * Math.cos(angle);
        const y1 = cy + R * Math.sin(angle);
        const x2 = cx + R * Math.cos(angle + sweep);
        const y2 = cy + R * Math.sin(angle + sweep);
        const ix1 = cx + r * Math.cos(angle + sweep);
        const iy1 = cy + r * Math.sin(angle + sweep);
        const ix2 = cx + r * Math.cos(angle);
        const iy2 = cy + r * Math.sin(angle);
        const large = sweep > Math.PI ? 1 : 0;

        const d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R},0,${large},1,${x2.toFixed(2)},${y2.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${r},${r},0,${large},0,${ix2.toFixed(2)},${iy2.toFixed(2)} Z`;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', color);
        path.setAttribute('stroke', 'var(--bg-card,#222)');
        path.setAttribute('stroke-width', '2');
        path.style.cursor = 'pointer';
        path.addEventListener('mouseenter', () => path.setAttribute('opacity', '0.8'));
        path.addEventListener('mouseleave', () => path.setAttribute('opacity', '1'));
        path.addEventListener('click', () => {
            document.getElementById('filterFiletype').value = f.type;
            filePath = '/';
            switchTab('files');
        });
        svg.appendChild(path);
        angle += frac * Math.PI * 2;
    });
}

// ─── SPARKLINE helper ─────────────────────────────────────────────────────────
function buildSparkline(values, w, h) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step  = w / (values.length - 1);
    const points = values.map((v, i) => {
        const x = (i * step).toFixed(1);
        const y = (h - ((v - min) / range) * (h - 8) - 4).toFixed(1);
        return x + ',' + y;
    }).join(' ');
    return `<svg width="${w}" height="${h}" class="sa-sparkline">
        <polyline points="${points}" fill="none" stroke="var(--primary,#2196f3)" stroke-width="2" stroke-linejoin="round"/>
    </svg>`;
}
