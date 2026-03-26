// rusNAS License Page — Ed25519 activation + apt token write
// cockpit/rusnas/js/license.js

// ── Constants ──────────────────────────────────────────────────────────────
// Raw 32-byte Ed25519 public key, base64-encoded
const OPERATOR_PUBLIC_KEY_B64 = "1d6UQHGzNP3wZPQVFpXUkc5qF+5UAyQlrUMSQAffdA0=";
const APT_HOST = "activate.rusnas.ru/apt/";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ── Base62 decode ──────────────────────────────────────────────────────────
function base62Decode(s) {
    let n = BigInt(0);
    for (const c of s) {
        const idx = BASE62.indexOf(c);
        if (idx === -1) throw new Error("Invalid Base62 character: " + c);
        n = n * 62n + BigInt(idx);
    }
    const leadingZeros = s.length - s.replace(new RegExp("^[" + BASE62[0] + "]+"), "").length;
    if (n === 0n) return new Uint8Array(s.length);
    const hex = n.toString(16);
    const padded = (hex.length % 2 ? "0" : "") + hex;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    }
    const result = new Uint8Array(leadingZeros + bytes.length);
    result.set(bytes, leadingZeros);
    return result;
}

// ── Normalize activation code ──────────────────────────────────────────────
function normalizeActivationCode(input) {
    let s = input.trim();
    if (s.toUpperCase().startsWith("RNAC-")) s = s.slice(5);
    return s.replace(/[\s\n\r-]/g, "");
}

// ── Verify and decode Ed25519 activation code ──────────────────────────────
async function verifyAndDecode(rawBase62) {
    const blob = base62Decode(rawBase62);
    if (blob.length < 64) throw new Error("Activation code too short");

    const signature    = blob.slice(0, 64);
    const payloadBytes = blob.slice(64);

    const rawKeyBytes = Uint8Array.from(atob(OPERATOR_PUBLIC_KEY_B64), c => c.charCodeAt(0));
    const publicKey = await crypto.subtle.importKey(
        "raw", rawKeyBytes,
        { name: "Ed25519" }, false, ["verify"]
    );

    const valid = await crypto.subtle.verify("Ed25519", publicKey, signature, payloadBytes);
    if (!valid) throw new Error("Неверная подпись кода активации");

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(payloadBytes));
}

// ── File helpers ────────────────────────────────────────────────────────────
function readFile(path) {
    return new Promise(function(resolve, reject) {
        cockpit.file(path).read()
            .done(resolve)
            .fail(reject);
    });
}

function writeFile(path, content, superuser) {
    return new Promise(function(resolve, reject) {
        cockpit.file(path, superuser ? { superuser: "require" } : {})
            .replace(content)
            .done(resolve)
            .fail(reject);
    });
}

// ── HTML escape helper ──────────────────────────────────────────────────────
function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
                           .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Load license status ─────────────────────────────────────────────────────
async function loadLicenseStatus() {
    var loadingEl = document.getElementById("lic-loading");
    var infoEl    = document.getElementById("lic-info");
    var noLicEl   = document.getElementById("lic-no-license");

    // Read serial
    var serial = "(неизвестен)";
    try { serial = (await readFile("/etc/rusnas/serial")).trim(); } catch(e) {}
    var serialEl = document.getElementById("lic-serial");
    if (serialEl) serialEl.textContent = serial;

    // Read license.json
    var lic = null;
    try {
        var raw = await readFile("/etc/rusnas/license.json");
        lic = JSON.parse(raw);
    } catch(e) {}

    if (loadingEl) loadingEl.style.display = "none";

    if (!lic) {
        if (noLicEl) noLicEl.style.display = "";
        if (infoEl)  infoEl.style.display  = "none";
        var hint = document.getElementById("reactivate-hint");
        if (hint) hint.style.display = "none";
        return;
    }

    if (infoEl)  infoEl.style.display  = "";
    if (noLicEl) noLicEl.style.display = "none";

    var hint = document.getElementById("reactivate-hint");
    if (hint) hint.style.display = "";

    var now     = Math.floor(Date.now() / 1000);
    var expired = lic.expires_at && lic.expires_at < now;
    var statusEl = document.getElementById("lic-status");
    if (statusEl) {
        statusEl.innerHTML = expired
            ? '<span style="color:var(--danger)">● Истекла</span>'
            : '<span style="color:var(--success)">● Активна</span>'
              + (lic.license_type ? ' (' + escHtml(lic.license_type) + ')' : "");
    }

    var custEl = document.getElementById("lic-customer");
    if (custEl) custEl.textContent = lic.customer || "—";

    var expEl = document.getElementById("lic-expires");
    if (expEl) expEl.textContent = lic.expires_at
        ? new Date(lic.expires_at * 1000).toLocaleDateString("ru-RU")
        : "Бессрочно";

    var featNames = {
        guard: "Guard", snapshots: "Снапшоты", ssd_tier: "SSD-кеш",
        dedup: "Дедупликация", storage_analyzer: "Анализатор", updates_features: "Обновления"
    };
    var features = lic.features || {};
    var active = Object.keys(features)
        .filter(function(k) { return k !== "core" && k !== "updates_security"; })
        .map(function(k) { return featNames[k] || k; });
    var featEl = document.getElementById("lic-features");
    if (featEl) featEl.textContent = active.length ? active.join(", ") : "Базовые";
}

// ── Activation ──────────────────────────────────────────────────────────────
async function activateLicense() {
    var btn   = document.getElementById("btn-activate");
    var errEl = document.getElementById("activate-error");
    var okEl  = document.getElementById("activate-success");
    var input = document.getElementById("rnac-input").value;

    if (errEl) errEl.style.display = "none";
    if (okEl)  okEl.style.display  = "none";
    btn.disabled = true;
    btn.textContent = "Проверка...";

    try {
        // 1. Normalize
        var rawCode = normalizeActivationCode(input);
        if (!rawCode) throw new Error("Введите код активации");

        // 2. Verify Ed25519 signature
        var payload = await verifyAndDecode(rawCode);

        // 3. Check serial matches this device
        var deviceSerial = "";
        try { deviceSerial = (await readFile("/etc/rusnas/serial")).trim(); } catch(e) {}
        if (payload.serial !== deviceSerial) {
            throw new Error(
                "Код выдан для серийника " + payload.serial +
                ", а это устройство — " + (deviceSerial || "(серийник не найден)")
            );
        }

        // 4. Write license.json (superuser required — /etc/rusnas/)
        await writeFile("/etc/rusnas/license.json", JSON.stringify(payload, null, 2), true);

        // 5. Write apt credentials (password = raw Base62 activation code)
        var aptConf = "machine " + APT_HOST + "\nlogin " + payload.serial + "\npassword " + rawCode + "\n";
        await writeFile("/etc/apt/auth.conf.d/rusnas.conf", aptConf, true);

        // 6. Update UI
        if (okEl) {
            okEl.textContent = "✅ Лицензия активирована!";
            okEl.style.display = "";
        }
        document.getElementById("rnac-input").value = "";

        // 7. Reload status card
        await loadLicenseStatus();

    } catch(err) {
        if (errEl) {
            errEl.textContent = "Ошибка: " + (err.message || String(err));
            errEl.style.display = "";
        }
    } finally {
        btn.disabled = false;
        btn.textContent = "Активировать";
    }
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function() {
    loadLicenseStatus();
    document.getElementById("btn-activate").addEventListener("click", activateLicense);
});
