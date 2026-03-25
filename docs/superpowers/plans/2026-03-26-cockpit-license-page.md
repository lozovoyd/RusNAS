# Cockpit License Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Лицензия" page to the rusNAS Cockpit plugin that lets users activate their device by pasting an RNAC activation code, verifies the Ed25519 signature locally using WebCrypto API, writes `license.json`, and updates the apt credentials in `auth.conf.d/rusnas.conf`.

**Architecture:** Pure browser-side Ed25519 verification (WebCrypto `crypto.subtle.verify`), no server contact during activation. Operator public key embedded as a constant in `license.js` at build time (copied from `operator_public.pem`). Cockpit file API writes protected files via superuser.

**Tech Stack:** Vanilla JS (ES2020), WebCrypto API, Cockpit API (`cockpit.file`, `cockpit.spawn`), HTML/CSS matching rusNAS style.css conventions.

**Spec:** `docs/superpowers/specs/2026-03-26-distribution-licensing-design.md` §10

**Dependency:** `operator_public.pem` must exist in `rusnas-license-server/` before running `build-deb.sh`. For dev/test, generate a test keypair with `keygen.py`.

---

## File Map

```
cockpit/rusnas/
├── license.html                   New Cockpit page
├── js/license.js                  Activation logic + UI
├── manifest.json                  ADD entry for license page  ← manual edit required
└── css/style.css                  No changes needed (reuse existing variables)
```

---

## Task 1: manifest.json entry + HTML scaffold

**Files:**
- Modify: `cockpit/rusnas/manifest.json`
- Create: `cockpit/rusnas/license.html`

- [ ] **Step 1: Add license page to manifest.json**

Read current manifest:
```bash
cat cockpit/rusnas/manifest.json
```

Add entry to the `"pages"` section (exact format must match existing entries):
```json
"license": {
  "label": "Лицензия",
  "order": 999
}
```

**Note:** `manifest.json` is NOT auto-updated by build-deb.sh — this manual step is required for Cockpit to show the page.

- [ ] **Step 2: Create license.html**

`cockpit/rusnas/license.html`:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Лицензия — rusNAS</title>
  <link rel="stylesheet" href="../base1/cockpit.css">
  <link rel="stylesheet" href="css/style.css">
  <script src="../base1/cockpit.js"></script>
</head>
<body>
<div class="container-fluid">
  <h2>🔑 Лицензия</h2>

  <!-- Status card -->
  <div id="license-status-card" class="card" style="max-width:600px;margin-bottom:24px">
    <div class="card-body">
      <div id="lic-loading" class="text-muted">Загрузка...</div>
      <div id="lic-info" style="display:none">
        <div><strong>Серийный номер:</strong> <span id="lic-serial"></span></div>
        <div><strong>Статус:</strong> <span id="lic-status"></span></div>
        <div id="lic-customer-row"><strong>Клиент:</strong> <span id="lic-customer"></span></div>
        <div id="lic-expires-row"><strong>Действует до:</strong> <span id="lic-expires"></span></div>
        <div id="lic-features-row"><strong>Фичи:</strong> <span id="lic-features"></span></div>
      </div>
      <div id="lic-no-license" style="display:none" class="text-muted">
        Лицензия не активирована
      </div>
    </div>
  </div>

  <!-- Activation form -->
  <div class="card" style="max-width:600px">
    <div class="card-body">
      <h4>Активировать лицензию</h4>
      <p class="text-muted" style="font-size:13px">
        Получите RNAC-код на <a href="https://activate.rusnas.ru" target="_blank">activate.rusnas.ru</a>,
        введите серийный номер вашего устройства и скопируйте полученный код.
      </p>
      <div class="form-group">
        <label>Код активации (RNAC-...)</label>
        <textarea id="rnac-input" class="form-control" rows="6"
          placeholder="RNAC-&#10;Ak3fP 2XqmB 9zK4L wN7Pq...&#10;&#10;Вставьте весь код целиком"
          style="font-family:monospace;font-size:12px"></textarea>
      </div>
      <div id="activate-error" class="alert alert-danger" style="display:none"></div>
      <div id="activate-success" class="alert alert-success" style="display:none"></div>
      <button id="btn-activate" class="btn btn-primary">Активировать</button>
    </div>
  </div>
</div>
<script src="js/license.js"></script>
</body>
</html>
```

- [ ] **Step 3: Deploy to VM and verify page appears in Cockpit nav**

```bash
./deploy.sh
```

Open `http://10.10.10.72:9090` — verify "Лицензия" appears in the rusNAS menu. Page will be blank/broken until JS is written.

- [ ] **Step 4: Commit scaffold**

```bash
git add cockpit/rusnas/license.html cockpit/rusnas/manifest.json
git commit -m "feat: license page HTML scaffold + manifest entry"
```

---

## Task 2: license.js — crypto utilities

**Files:**
- Create: `cockpit/rusnas/js/license.js` (start with pure functions)

The file has two sections:
1. **Crypto utilities** — Base62 decode, Ed25519 verify via WebCrypto (testable in Node)
2. **Cockpit UI** — reads/writes files, handles DOM events (not unit-tested)

- [ ] **Step 1: Write the Base62 + normalization functions**

Start `cockpit/rusnas/js/license.js` with the pure functions:

```javascript
// ── Constants ──────────────────────────────────────────────────────────────
// IMPORTANT: Replace this with the real operator_public.pem content after keygen.py
// Format: base64-encoded raw 32-byte Ed25519 public key (SubjectPublicKeyInfo stripped)
const OPERATOR_PUBLIC_KEY_B64 = "REPLACE_WITH_REAL_KEY_BASE64";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ── Base62 decode ──────────────────────────────────────────────────────────
function base62Decode(s) {
    let n = BigInt(0);
    for (const c of s) {
        const idx = BASE62.indexOf(c);
        if (idx === -1) throw new Error("Invalid Base62 character: " + c);
        n = n * 62n + BigInt(idx);
    }
    // Convert BigInt to Uint8Array
    const leadingZeros = s.length - s.replace(new RegExp("^[" + BASE62[0] + "]+"), "").length;
    if (n === 0n) return new Uint8Array(s.length);
    const hex = n.toString(16).padStart(2, "0");
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

    const signature   = blob.slice(0, 64);
    const payloadBytes = blob.slice(64);

    // Import operator public key (raw 32-byte Ed25519 key)
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
```

- [ ] **Step 2: Test Base62 decode + verifyAndDecode in browser console**

Deploy to VM:
```bash
./deploy.sh
```

Open browser dev tools on the license page, run:
```javascript
// Test 1: basic decode
const dec = base62Decode("2");
console.assert(dec[0] === 2, "Base62 decode failed");
console.log("Base62 basic OK");

// Test 2: leading-zero invariant
// Ed25519 signatures never start with 0x00 (R point always has high bit set),
// so real activation codes will not exercise this path. Verify the constraint holds:
// A code starting with BASE62[0]="0" chars would decode to leading zero bytes.
// For safety, confirm roundtrip with a zero-prefixed short value:
const zeroBytes = new Uint8Array([0, 0, 1]);
// Manually encode: BigInt(1) → "1" in base62, padded with 2 leading "0"s = "001"
const expectedEncoded = "001";
const decoded = base62Decode(expectedEncoded);
console.assert(decoded.length >= 1 && decoded[decoded.length-1] === 1,
  "Base62 leading zero roundtrip failed: " + Array.from(decoded));
console.log("Base62 leading-zero OK (last byte = 1)");

// Test 3: normalization
const raw = normalizeActivationCode("RNAC-\nAk3fP 2XqmB");
console.assert(raw === "Ak3fP2XqmB", "normalize failed: " + raw);
console.log("Normalize OK");

// Test 4: verifyAndDecode with a real key (run AFTER embedding operator_public.pem)
// Generate a test code on the Mac:
//   cd rusnas-license-server && python3 admin.py gen-code RUSNAS-TEST-BCDF-GHJK-LMNP
// Paste the RNAC- code here, normalize it, and verify:
// const testRaw = normalizeActivationCode("RNAC-\n<paste code here>");
// verifyAndDecode(testRaw).then(p => { console.log("verifyAndDecode OK", p.serial); })
//   .catch(e => { console.error("verifyAndDecode FAILED", e); });
// Expected: logs "verifyAndDecode OK RUSNAS-TEST-BCDF-GHJK-LMNP"
```
Expected: first 3 console.log lines appear without assertion errors. Test 4 must be run manually after a real key is embedded.

- [ ] **Step 3: Embed real operator_public.pem**

After generating keys with `python3 rusnas-license-server/keygen.py`:
```bash
# Extract raw 32-byte Ed25519 public key from PEM and base64 encode it
python3 -c "
from cryptography.hazmat.primitives.serialization import load_pem_public_key, Encoding, PublicFormat
import base64
pub = load_pem_public_key(open('rusnas-license-server/operator_public.pem','rb').read())
raw = pub.public_bytes(Encoding.Raw, PublicFormat.Raw)
print(base64.b64encode(raw).decode())
"
```

Replace `REPLACE_WITH_REAL_KEY_BASE64` in `license.js` with the output.

- [ ] **Step 4: Commit crypto utilities**

```bash
git add cockpit/rusnas/js/license.js
git commit -m "feat: license.js crypto utilities (Base62 + Ed25519 verify)"
```

---

## Task 3: license.js — Cockpit UI + activation flow

**Files:**
- Modify: `cockpit/rusnas/js/license.js` (add Cockpit UI functions)

- [ ] **Step 1: Add file read helpers and status loader**

Append to `license.js`:
```javascript
// ── File helpers ────────────────────────────────────────────────────────────
function readFile(path) {
    return new Promise((resolve, reject) => {
        cockpit.file(path).read()
            .done(resolve)
            .fail(reject);
    });
}

function writeFile(path, content, superuser) {
    return new Promise((resolve, reject) => {
        cockpit.file(path, superuser ? { superuser: "require" } : {})
            .replace(content)
            .done(resolve)
            .fail(reject);
    });
}

// ── Load license status ─────────────────────────────────────────────────────
async function loadLicenseStatus() {
    const loadingEl = document.getElementById("lic-loading");
    const infoEl    = document.getElementById("lic-info");
    const noLicEl   = document.getElementById("lic-no-license");

    // Read serial
    let serial = "(неизвестен)";
    try { serial = (await readFile("/etc/rusnas/serial")).trim(); } catch {}
    document.getElementById("lic-serial").textContent = serial;

    // Read license.json
    let lic = null;
    try {
        const raw = await readFile("/etc/rusnas/license.json");
        lic = JSON.parse(raw);
    } catch {}

    loadingEl.style.display = "none";

    if (!lic) {
        noLicEl.style.display = "";
        infoEl.style.display  = "none";
        return;
    }

    infoEl.style.display  = "";
    noLicEl.style.display = "none";

    const now = Math.floor(Date.now() / 1000);
    const expired = lic.expires_at && lic.expires_at < now;
    document.getElementById("lic-status").innerHTML = expired
        ? '<span style="color:#e74c3c">● Истекла</span>'
        : '<span style="color:#2ecc71">● Активна</span>'
        + (lic.license_type ? ` (${lic.license_type})` : "");

    document.getElementById("lic-customer").textContent = lic.customer || "—";
    document.getElementById("lic-expires").textContent  = lic.expires_at
        ? new Date(lic.expires_at * 1000).toLocaleDateString("ru-RU")
        : "Бессрочно";

    const features = lic.features || {};
    const featNames = { guard: "Guard", snapshots: "Снапшоты", ssd_tier: "SSD-кеш",
        dedup: "Дедупликация", storage_analyzer: "Анализатор", updates_features: "Обновления" };
    const active = Object.entries(features)
        .filter(([k]) => !["core","updates_security"].includes(k))
        .map(([k]) => featNames[k] || k);
    document.getElementById("lic-features").textContent = active.length ? active.join(", ") : "Базовые";
}
```

- [ ] **Step 2: Add activation handler**

Append to `license.js`:
```javascript
// ── Activation ──────────────────────────────────────────────────────────────
async function activateLicense() {
    const btn      = document.getElementById("btn-activate");
    const errEl    = document.getElementById("activate-error");
    const okEl     = document.getElementById("activate-success");
    const input    = document.getElementById("rnac-input").value;

    errEl.style.display = "none";
    okEl.style.display  = "none";
    btn.disabled = true;
    btn.textContent = "Проверка...";

    try {
        // 1. Normalize
        const raw = normalizeActivationCode(input);
        if (!raw) throw new Error("Введите код активации");

        // 2. Verify Ed25519
        const payload = await verifyAndDecode(raw);

        // 3. Check serial matches
        let deviceSerial = "";
        try { deviceSerial = (await readFile("/etc/rusnas/serial")).trim(); } catch {}
        if (payload.serial !== deviceSerial) {
            throw new Error(
                `Код выдан для серийника ${payload.serial}, а это устройство — ${deviceSerial}`
            );
        }

        // 4. Write license.json
        await writeFile("/etc/rusnas/license.json", JSON.stringify(payload, null, 2), true);

        // 5. Write apt credentials (password = raw Base62 activation code)
        const aptHost = "activate.rusnas.ru/apt/";
        const aptConf = `machine ${aptHost}\nlogin ${payload.serial}\npassword ${raw}\n`;
        await writeFile("/etc/apt/auth.conf.d/rusnas.conf", aptConf, true);

        // 6. Update UI
        okEl.textContent = "✅ Лицензия активирована!";
        okEl.style.display = "";
        document.getElementById("rnac-input").value = "";

        // Reload status card
        await loadLicenseStatus();

    } catch (err) {
        errEl.textContent = "Ошибка: " + (err.message || String(err));
        errEl.style.display = "";
    } finally {
        btn.disabled = false;
        btn.textContent = "Активировать";
    }
}

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", function () {
    loadLicenseStatus();
    document.getElementById("btn-activate").addEventListener("click", activateLicense);
});
```

- [ ] **Step 3: Deploy and manual test**

```bash
./deploy.sh
```

In the browser at `http://10.10.10.72:9090`:
1. Navigate to rusNAS → Лицензия
2. Status card shows serial from `/etc/rusnas/serial`
3. Status shows "Лицензия не активирована" (if no license.json)
4. Generate a test activation code:
   ```bash
   cd rusnas-license-server
   python3 admin.py serial add RUSNAS-TEST-BCDF-GHJK-LMNP
   python3 admin.py license create --serial RUSNAS-TEST-BCDF-GHJK-LMNP --type standard --expires 2027-01-01 --customer "Test Co" --features guard,snapshots
   python3 admin.py gen-code RUSNAS-TEST-BCDF-GHJK-LMNP
   ```
5. Write the device serial: `echo "RUSNAS-TEST-BCDF-GHJK-LMNP" | sudo tee /etc/rusnas/serial`
6. Paste the RNAC code into the textarea → click Активировать
7. Verify: status card shows "● Активна (standard)", customer "Test Co", features

Verify files written:
```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "cat /etc/rusnas/license.json && echo '---' && cat /etc/apt/auth.conf.d/rusnas.conf"
```

- [ ] **Step 4: Test error cases in browser**

- Paste garbled text → should show "Неверная подпись" or "Base62 character" error
- Paste valid RNAC code for wrong serial → should show serial mismatch error
- Click Активировать with empty textarea → should show "Введите код активации"

- [ ] **Step 5: Commit**

```bash
git add cockpit/rusnas/js/license.js cockpit/rusnas/license.html
git commit -m "feat: cockpit license page — Ed25519 activation + apt token write"
```

---

## Task 4: Edge cases + UX polish

**Files:**
- Modify: `cockpit/rusnas/js/license.js`
- Modify: `cockpit/rusnas/license.html`

- [ ] **Step 1: Handle expired license display**

In `loadLicenseStatus()`, expired licenses should show clearly:
```javascript
// Already handled by the 'expired' check — verify in browser:
// Set expires_at to past timestamp in license.json, reload page
// Expected: "● Истекла" in red
```

Manually test:
```bash
sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no rusnas@10.10.10.72 \
  "sudo python3 -c \"import json; d=json.load(open('/etc/rusnas/license.json')); d['expires_at']=1000000000; json.dump(d,open('/etc/rusnas/license.json','w'))\""
```
Reload page → verify red "● Истекла" shows.

Reset to valid:
```bash
# Re-activate with a valid code
```

- [ ] **Step 2: Add "Переактивировать" hint when already active**

In `license.html`, add below the activation textarea:
```html
<p class="text-muted" id="reactivate-hint" style="font-size:12px;display:none">
  Если нужно обновить лицензию (продление, новые фичи) — вставьте новый RNAC-код и нажмите Активировать снова.
</p>
```

In `loadLicenseStatus()`, show hint when license.json exists:
```javascript
const hint = document.getElementById("reactivate-hint");
if (hint) hint.style.display = lic ? "" : "none";
```

- [ ] **Step 3: Final deploy + verification**

```bash
./deploy.sh
```

Full smoke test:
1. Page loads without JS errors (check browser console)
2. Status card shows correct info
3. Activation with valid code works
4. Activation with invalid code shows error
5. Files written with correct content

- [ ] **Step 4: Final commit**

```bash
git add cockpit/rusnas/js/license.js cockpit/rusnas/license.html
git commit -m "feat: license page complete — activation, status display, error handling"
```
