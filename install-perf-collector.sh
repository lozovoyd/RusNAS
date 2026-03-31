#!/bin/bash
# Install rusNAS Performance Collector Daemon
set -e
HOST="rusnas@10.10.10.72"
PASS="kl4389qd"
SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no $HOST"
SCP="sshpass -p '$PASS' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "==> Copying perf-collector.py..."
eval $SCP cockpit/rusnas/scripts/perf-collector.py $HOST:/tmp/

echo "==> Installing..."
eval $SSH "echo '$PASS' | sudo -S bash -c '
cp /tmp/perf-collector.py /usr/share/cockpit/rusnas/scripts/perf-collector.py
chmod 755 /usr/share/cockpit/rusnas/scripts/perf-collector.py
touch /var/lib/rusnas/perf-history.json
chmod 666 /var/lib/rusnas/perf-history.json

# Stop old timer if exists
systemctl stop rusnas-perf-collector.timer 2>/dev/null || true
systemctl disable rusnas-perf-collector.timer 2>/dev/null || true
rm -f /etc/systemd/system/rusnas-perf-collector.timer

cat > /etc/systemd/system/rusnas-perf-collector.service << EOF
[Unit]
Description=rusNAS Performance Metrics Collector
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/share/cockpit/rusnas/scripts/perf-collector.py
Restart=always
RestartSec=5
Nice=19
IOSchedulingClass=idle
MemoryMax=32M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now rusnas-perf-collector.service
echo DONE
'"

echo "==> Verifying..."
sleep 12
eval $SSH "systemctl is-active rusnas-perf-collector.service && wc -c /var/lib/rusnas/perf-history.json"
echo "==> Done!"
