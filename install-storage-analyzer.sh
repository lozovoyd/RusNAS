#!/usr/bin/env bash
# install-storage-analyzer.sh — Deploy rusNAS Storage Analyzer to VM
set -e

VM="rusnas@10.10.10.72"
SSH="sshpass -p 'kl4389qd' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p 'kl4389qd' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "==> Installing rusNAS Storage Analyzer..."

# Create directories on VM
eval "$SSH $VM" 'echo kl4389qd | sudo -S bash -c "
  mkdir -p /usr/share/cockpit/rusnas/scripts
  mkdir -p /var/lib/rusnas
  mkdir -p /var/log/rusnas
  mkdir -p /tmp/rusnas-sa-deploy
"'

# Copy backend scripts
eval "$SCP" rusnas-storage-analyzer/storage-collector.py    "$VM:/tmp/rusnas-sa-deploy/"
eval "$SCP" rusnas-storage-analyzer/storage-analyzer-api.py "$VM:/tmp/rusnas-sa-deploy/"

# Copy systemd units
eval "$SCP" rusnas-storage-analyzer/rusnas-storage-collector.service "$VM:/tmp/rusnas-sa-deploy/"
eval "$SCP" rusnas-storage-analyzer/rusnas-storage-collector.timer   "$VM:/tmp/rusnas-sa-deploy/"

# Copy Cockpit frontend files
eval "$SCP" cockpit/rusnas/storage-analyzer.html         "$VM:/tmp/rusnas-sa-deploy/"
eval "$SCP" cockpit/rusnas/js/storage-analyzer.js        "$VM:/tmp/rusnas-sa-deploy/"
eval "$SCP" cockpit/rusnas/css/storage-analyzer.css      "$VM:/tmp/rusnas-sa-deploy/"
eval "$SCP" cockpit/rusnas/manifest.json                 "$VM:/tmp/rusnas-sa-deploy/"
eval "$SCP" cockpit/rusnas/js/dashboard.js               "$VM:/tmp/rusnas-sa-deploy/"

echo "==> Installing files on VM..."
eval "$SSH $VM" 'echo kl4389qd | sudo -S bash -c "
  # Backend scripts
  cp /tmp/rusnas-sa-deploy/storage-collector.py    /usr/share/cockpit/rusnas/scripts/
  cp /tmp/rusnas-sa-deploy/storage-analyzer-api.py /usr/share/cockpit/rusnas/scripts/
  chmod 755 /usr/share/cockpit/rusnas/scripts/storage-collector.py
  chmod 755 /usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py

  # Systemd units
  cp /tmp/rusnas-sa-deploy/rusnas-storage-collector.service /etc/systemd/system/
  cp /tmp/rusnas-sa-deploy/rusnas-storage-collector.timer   /etc/systemd/system/
  chmod 644 /etc/systemd/system/rusnas-storage-collector.*

  # Cockpit plugin files
  cp /tmp/rusnas-sa-deploy/storage-analyzer.html    /usr/share/cockpit/rusnas/
  cp /tmp/rusnas-sa-deploy/storage-analyzer.js      /usr/share/cockpit/rusnas/js/
  cp /tmp/rusnas-sa-deploy/storage-analyzer.css     /usr/share/cockpit/rusnas/css/
  cp /tmp/rusnas-sa-deploy/manifest.json            /usr/share/cockpit/rusnas/
  cp /tmp/rusnas-sa-deploy/dashboard.js             /usr/share/cockpit/rusnas/js/

  # Fix permissions
  chown -R root:root /usr/share/cockpit/rusnas/
  find /usr/share/cockpit/rusnas -type f -exec chmod 644 {} +
  find /usr/share/cockpit/rusnas -type d -exec chmod 755 {} +
  chmod 755 /usr/share/cockpit/rusnas/scripts/*.py

  # Sudoers: allow running storage scripts
  cat > /etc/sudoers.d/rusnas-storage << EOF
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/storage-collector.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/storage-analyzer-api.py *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/du -sb --apparent-size *
rusnas ALL=(ALL) NOPASSWD: /usr/bin/find * -type f *
EOF
  chmod 440 /etc/sudoers.d/rusnas-storage

  # Enable & start timer
  systemctl daemon-reload
  systemctl enable rusnas-storage-collector.timer
  systemctl start  rusnas-storage-collector.timer

  # Initialize DB and run first scan
  python3 /usr/share/cockpit/rusnas/scripts/storage-collector.py --init-db

  rm -rf /tmp/rusnas-sa-deploy
  echo DONE
"'

echo ""
echo "==> Running initial scan (this may take 1-2 minutes)..."
eval "$SSH $VM" 'echo kl4389qd | sudo -S python3 /usr/share/cockpit/rusnas/scripts/storage-collector.py' || echo "(scan failed, will retry on next timer tick)"

echo ""
echo "✅  Storage Analyzer installed!"
echo "    Open: https://10.10.10.72:9090  → Анализ пространства 💾"
