#!/bin/bash
set -euo pipefail

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SCP="sshpass -p '$PASS' scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no $VM"

echo "=== Deploy rusNAS Container Manager ==="

# 1. Install packages on VM
$SSH "sudo apt-get install -y podman podman-compose slirp4netns fuse-overlayfs crun uidmap" || true

# 2. Create container user
$SSH "id rusnas-containers &>/dev/null || sudo useradd -r -m -d /var/lib/rusnas-containers -s /bin/bash rusnas-containers"

# 3. Add subuid/subgid
$SSH "grep -q '^rusnas-containers' /etc/subuid || echo 'rusnas-containers:100000:65536' | sudo tee -a /etc/subuid"
$SSH "grep -q '^rusnas-containers' /etc/subgid || echo 'rusnas-containers:100000:65536' | sudo tee -a /etc/subgid"

# 4. Create directories
$SSH "sudo mkdir -p /var/lib/rusnas-containers/{catalog,compose,nginx-apps}"
$SSH "sudo mkdir -p /etc/rusnas/containers"
$SSH "sudo chown -R rusnas-containers:rusnas-containers /var/lib/rusnas-containers"

# 5. Initialize podman for rusnas-containers user
$SSH "sudo -u rusnas-containers podman system migrate 2>/dev/null || true"

# 6. Copy CGI backend
$SSH "sudo mkdir -p /usr/lib/rusnas/cgi"
eval "$SCP cockpit/rusnas/cgi/container_api.py $VM:/tmp/container_api.py"
$SSH "sudo cp /tmp/container_api.py /usr/lib/rusnas/cgi/container_api.py && sudo chmod 755 /usr/lib/rusnas/cgi/container_api.py"

# 7. Copy catalog
eval "$SCP -r cockpit/rusnas/catalog $VM:/tmp/rusnas-catalog"
$SSH "sudo cp -r /tmp/rusnas-catalog /usr/share/cockpit/rusnas/catalog && sudo chmod -R 755 /usr/share/cockpit/rusnas/catalog"

# 8. Copy Cockpit plugin files
eval "$SCP cockpit/rusnas/containers.html $VM:/tmp/"
eval "$SCP cockpit/rusnas/css/containers.css $VM:/tmp/"
eval "$SCP cockpit/rusnas/js/containers.js $VM:/tmp/"
eval "$SCP cockpit/rusnas/manifest.json $VM:/tmp/"
$SSH "sudo cp /tmp/containers.html /usr/share/cockpit/rusnas/containers.html"
$SSH "sudo cp /tmp/containers.css /usr/share/cockpit/rusnas/css/containers.css"
$SSH "sudo cp /tmp/containers.js /usr/share/cockpit/rusnas/js/containers.js"
$SSH "sudo cp /tmp/manifest.json /usr/share/cockpit/rusnas/manifest.json"

# 9. Deploy updated dashboard.js
eval "$SCP cockpit/rusnas/js/dashboard.js $VM:/tmp/"
$SSH "sudo cp /tmp/dashboard.js /usr/share/cockpit/rusnas/js/dashboard.js"

# 10. Configure nginx include (if nginx installed)
$SSH "test -d /etc/nginx/conf.d && echo 'include /var/lib/rusnas-containers/nginx-apps/*.conf;' | sudo tee /etc/nginx/conf.d/rusnas-apps.conf > /dev/null || true"
$SSH "test -d /etc/nginx && sudo nginx -t && sudo systemctl reload nginx 2>/dev/null || true"

# 11. Sudoers for container_api.py
cat > /tmp/rusnas-containers-sudoers << 'EOF'
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/cgi/container_api.py *
rusnas ALL=(rusnas-containers) NOPASSWD: /usr/bin/podman *
rusnas ALL=(rusnas-containers) NOPASSWD: /usr/bin/podman-compose *
EOF
eval "$SCP /tmp/rusnas-containers-sudoers $VM:/tmp/"
$SSH "sudo cp /tmp/rusnas-containers-sudoers /etc/sudoers.d/rusnas-containers && sudo chmod 440 /etc/sudoers.d/rusnas-containers"

# 12. Fix permissions
$SSH "sudo find /usr/share/cockpit/rusnas -type f -exec chmod 644 {} \;"
$SSH "sudo find /usr/share/cockpit/rusnas -type d -exec chmod 755 {} \;"

echo "=== Container Manager deployed successfully ==="
echo "Navigate to https://10.10.10.72:9090/rusnas/containers to verify"
