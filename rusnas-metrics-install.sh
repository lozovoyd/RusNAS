#!/bin/bash
# rusnas-metrics-install.sh — install rusNAS Metrics Server on VM
# Usage: ./rusnas-metrics-install.sh
# Requires: SSH access to rusnas@10.10.10.72

set -e

VM="rusnas@10.10.10.72"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== rusNAS Metrics Server install ==="

# Transfer files
echo "Transferring files..."
scp "$SCRIPT_DIR/rusnas-metrics/metrics_server.py" "$VM:/tmp/metrics_server.py"
scp "$SCRIPT_DIR/rusnas-metrics/rusnas-metrics.service" "$VM:/tmp/rusnas-metrics.service"

# Install on VM
ssh "$VM" bash << 'REMOTE'
set -e
echo "Installing metrics server..."

# Create lib dir
sudo mkdir -p /usr/local/lib/rusnas

# Copy server script
sudo cp /tmp/metrics_server.py /usr/local/lib/rusnas/metrics_server.py
sudo chmod 755 /usr/local/lib/rusnas/metrics_server.py

# Install systemd service
sudo cp /tmp/rusnas-metrics.service /etc/systemd/system/rusnas-metrics.service
sudo chmod 644 /etc/systemd/system/rusnas-metrics.service

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable rusnas-metrics
sudo systemctl restart rusnas-metrics

sleep 2
STATUS=$(systemctl is-active rusnas-metrics)
echo "Service status: $STATUS"

if [ "$STATUS" = "active" ]; then
    echo "✅ rusnas-metrics is running on port 9100"
    echo "   Test: curl http://localhost:9100/metrics"
    echo "   JSON: curl http://localhost:9100/metrics.json"
else
    echo "❌ Service failed to start"
    journalctl -u rusnas-metrics --no-pager -n 20
    exit 1
fi
REMOTE

echo "=== Done ==="
