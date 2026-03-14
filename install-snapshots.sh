#!/bin/bash
# install-snapshots.sh — Deploy rusNAS snapshot system to VM
# Usage: ./install-snapshots.sh [--setup-btrfs]
# --setup-btrfs: create a Btrfs loop pool at /mnt/btrfspool for testing
set -e

VM_HOST="10.10.10.72"
VM_USER="rusnas"
VM_PASS="kl4389qd"
SSH="sshpass -p ${VM_PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p ${VM_PASS} scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

SETUP_BTRFS=0
for arg in "$@"; do
  [[ "$arg" == "--setup-btrfs" ]] && SETUP_BTRFS=1
done

echo "==> Deploying rusNAS snapshots to ${VM_USER}@${VM_HOST}"

# ── 1. Install system dependencies ──────────────────────────────────────────
echo "==> Installing dependencies..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S apt-get install -y -q \
    btrfs-progs python3-croniter python3 2>&1 | tail -3"

# ── 2. Create directories ────────────────────────────────────────────────────
echo "==> Creating directories..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
    mkdir -p /var/lib/rusnas
    mkdir -p /var/log/rusnas
    chmod 750 /var/lib/rusnas
    chmod 755 /var/log/rusnas
'"

# ── 3. Deploy rusnas-snap CLI ────────────────────────────────────────────────
echo "==> Deploying rusnas-snap CLI..."
$SCP rusnas-snap/rusnas-snap ${VM_USER}@${VM_HOST}:/tmp/rusnas-snap
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
    cp /tmp/rusnas-snap /usr/local/bin/rusnas-snap
    chmod 755 /usr/local/bin/rusnas-snap
    chown root:root /usr/local/bin/rusnas-snap
'"

# ── 4. Initialize database ───────────────────────────────────────────────────
echo "==> Initializing database..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S /usr/local/bin/rusnas-snap init-db"

# ── 5. Deploy systemd timer ──────────────────────────────────────────────────
echo "==> Deploying systemd timer..."
$SCP rusnas-snap/rusnas-snapd.service ${VM_USER}@${VM_HOST}:/tmp/rusnas-snapd.service
$SCP rusnas-snap/rusnas-snapd.timer   ${VM_USER}@${VM_HOST}:/tmp/rusnas-snapd.timer
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
    cp /tmp/rusnas-snapd.service /etc/systemd/system/
    cp /tmp/rusnas-snapd.timer   /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now rusnas-snapd.timer
'"

# ── 6. Deploy apt pre-update hook ────────────────────────────────────────────
echo "==> Deploying apt hook..."
$SCP rusnas-snap/99rusnas-snapshot ${VM_USER}@${VM_HOST}:/tmp/99rusnas-snapshot
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
    cp /tmp/99rusnas-snapshot /etc/apt/apt.conf.d/99rusnas-snapshot
    chmod 644 /etc/apt/apt.conf.d/99rusnas-snapshot
'"

# ── 7. Deploy Cockpit UI ─────────────────────────────────────────────────────
echo "==> Deploying Cockpit UI..."
$SCP cockpit/rusnas/snapshots.html     ${VM_USER}@${VM_HOST}:/tmp/snapshots.html
$SCP cockpit/rusnas/js/snapshots.js    ${VM_USER}@${VM_HOST}:/tmp/snapshots.js
$SCP cockpit/rusnas/manifest.json      ${VM_USER}@${VM_HOST}:/tmp/manifest.json
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
    cp /tmp/snapshots.html  /usr/share/cockpit/rusnas/snapshots.html
    cp /tmp/snapshots.js    /usr/share/cockpit/rusnas/js/snapshots.js
    cp /tmp/manifest.json   /usr/share/cockpit/rusnas/manifest.json
    chmod 644 /usr/share/cockpit/rusnas/snapshots.html
    chmod 644 /usr/share/cockpit/rusnas/js/snapshots.js
    chmod 644 /usr/share/cockpit/rusnas/manifest.json
'"

# ── 8. Sudoers rule ──────────────────────────────────────────────────────────
echo "==> Configuring sudoers..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
    echo \"rusnas ALL=(ALL) NOPASSWD: /usr/local/bin/rusnas-snap\" > /etc/sudoers.d/rusnas-snap
    chmod 440 /etc/sudoers.d/rusnas-snap
'"

# ── 9. Setup Btrfs pool (optional, for testing) ──────────────────────────────
if [[ $SETUP_BTRFS -eq 1 ]]; then
    echo "==> Setting up Btrfs loop pool for testing..."
    $SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -c '
        # Only create if not already exists
        if ! mountpoint -q /mnt/btrfspool; then
            IMG=/var/lib/rusnas/btrfs-pool.img
            if [[ ! -f \"\$IMG\" ]]; then
                echo \"  Creating 5G loop image...\"
                truncate -s 5G \"\$IMG\"
                mkfs.btrfs -L rusnas-pool \"\$IMG\" -f
            fi
            mkdir -p /mnt/btrfspool
            mount -o loop \"\$IMG\" /mnt/btrfspool
            echo \"  Btrfs pool mounted at /mnt/btrfspool\"
        else
            echo \"  Already mounted\"
        fi

        # Create subvolumes if missing
        for name in public documents backups; do
            SUBVOL=\"/mnt/btrfspool/shares/\$name\"
            if [[ ! -d \"\$SUBVOL\" ]]; then
                mkdir -p /mnt/btrfspool/shares
                btrfs subvolume create \"\$SUBVOL\"
                echo \"  Created subvolume: \$SUBVOL\"
                # Add some test files
                echo \"Hello from \$name\" > \"\$SUBVOL/readme.txt\"
                dd if=/dev/urandom of=\"\$SUBVOL/sample_\$name.bin\" bs=128k count=1 2>/dev/null
            fi
        done
        echo \"  Subvolumes ready\"
    '"

    echo "==> Configuring schedules for Btrfs subvolumes..."
    for name in public documents backups; do
        $SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S /usr/local/bin/rusnas-snap schedule set \
            /mnt/btrfspool/shares/${name} \
            --cron '0 * * * *' \
            --retention-last 10 \
            --retention-hourly 24 \
            --retention-daily 7 \
            --retention-weekly 4 \
            --retention-monthly 3"
    done
fi

echo ""
echo "==> Done!"
echo "    rusnas-snap:     /usr/local/bin/rusnas-snap"
echo "    database:        /var/lib/rusnas/snaps.db"
echo "    timer:           systemctl status rusnas-snapd.timer"
echo "    cockpit:         https://${VM_HOST}:9090 → Снапшоты 📸"
if [[ $SETUP_BTRFS -eq 1 ]]; then
    echo "    btrfs pool:      /mnt/btrfspool/shares/{public,documents,backups}"
fi
