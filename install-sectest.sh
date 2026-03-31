#!/bin/bash
set -e

# ─── rusNAS Security Self-Test Installer ────────────────────────────
# Deploys sectest to VM and installs required pentest tools
# Usage: ./install-sectest.sh [--skip-tools]

DIR="$(cd "$(dirname "$0")" && pwd)"
VM_HOST="10.10.10.72"
VM_USER="rusnas"
VM_PASS="kl4389qd"
SKIP_TOOLS=false

[ "$1" = "--skip-tools" ] && SKIP_TOOLS=true

SSH="sshpass -p ${VM_PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p ${VM_PASS} scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "==> Uploading sectest files..."
$SSH ${VM_USER}@${VM_HOST} "rm -rf /tmp/sectest && mkdir -p /tmp/sectest/checks /tmp/sectest/wordlists"
$SCP "${DIR}/rusnas-sectest/sectest.py" ${VM_USER}@${VM_HOST}:/tmp/sectest/
$SCP "${DIR}/rusnas-sectest/checks/"*.py ${VM_USER}@${VM_HOST}:/tmp/sectest/checks/
$SCP "${DIR}/rusnas-sectest/wordlists/rusnas-paths.txt" ${VM_USER}@${VM_HOST}:/tmp/sectest/wordlists/
$SCP "${DIR}/rusnas-sectest/rusnas-sectest.service" ${VM_USER}@${VM_HOST}:/tmp/sectest/
$SCP "${DIR}/rusnas-sectest/rusnas-sectest.timer" ${VM_USER}@${VM_HOST}:/tmp/sectest/

echo "==> Installing on VM..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -s" << 'REMOTE'
set -e

# Create directories
mkdir -p /usr/lib/rusnas/sectest/checks
mkdir -p /usr/lib/rusnas/sectest/wordlists
mkdir -p /var/log/rusnas
mkdir -p /var/lib/rusnas

# Copy files
cp /tmp/sectest/sectest.py /usr/lib/rusnas/sectest/
cp /tmp/sectest/checks/*.py /usr/lib/rusnas/sectest/checks/
cp /tmp/sectest/wordlists/rusnas-paths.txt /usr/lib/rusnas/sectest/wordlists/

# Permissions
chmod 755 /usr/lib/rusnas/sectest/sectest.py
chmod 644 /usr/lib/rusnas/sectest/checks/*.py
chmod 644 /usr/lib/rusnas/sectest/wordlists/rusnas-paths.txt

# Sudoers
cat > /etc/sudoers.d/rusnas-sectest << EOF
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/sectest/sectest.py
rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/lib/rusnas/sectest/sectest.py *
EOF
chmod 440 /etc/sudoers.d/rusnas-sectest

# Systemd units
cp /tmp/sectest/rusnas-sectest.service /lib/systemd/system/
cp /tmp/sectest/rusnas-sectest.timer /lib/systemd/system/
chmod 644 /lib/systemd/system/rusnas-sectest.service
chmod 644 /lib/systemd/system/rusnas-sectest.timer

systemctl daemon-reload
systemctl enable rusnas-sectest.timer
systemctl start rusnas-sectest.timer

# State file readable by Cockpit
touch /var/lib/rusnas/sectest-last.json
chmod 644 /var/lib/rusnas/sectest-last.json

# Cleanup
rm -rf /tmp/sectest

echo "==> Sectest installed to /usr/lib/rusnas/sectest/"
REMOTE

# Install pentest tools on VM
if [ "$SKIP_TOOLS" = "false" ]; then
    echo "==> Installing pentest tools on VM..."
    $SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S bash -s" << 'TOOLS'
    set -e
    export DEBIAN_FRONTEND=noninteractive

    # nmap + sqlmap + smbclient (from apt)
    apt-get update -qq
    apt-get install -y -qq nmap sqlmap smbclient nfs-common 2>/dev/null

    # nuclei (binary download — Go compilation too slow on VM)
    if ! command -v nuclei &>/dev/null; then
        echo "==> Installing nuclei..."
        NUCLEI_VER="3.3.7"
        ARCH=$(dpkg --print-architecture)
        case $ARCH in
            amd64) NUCLEI_ARCH="linux_amd64" ;;
            arm64) NUCLEI_ARCH="linux_arm64" ;;
            *) echo "Unsupported arch: $ARCH"; exit 0 ;;
        esac
        curl -sL "https://github.com/projectdiscovery/nuclei/releases/download/v${NUCLEI_VER}/nuclei_${NUCLEI_VER}_${NUCLEI_ARCH}.zip" -o /tmp/nuclei.zip
        cd /tmp && unzip -o nuclei.zip nuclei && mv nuclei /usr/local/bin/ && chmod 755 /usr/local/bin/nuclei
        rm -f /tmp/nuclei.zip
        nuclei -update-templates 2>/dev/null || true
    fi

    # ffuf (binary download)
    if ! command -v ffuf &>/dev/null; then
        echo "==> Installing ffuf..."
        FFUF_VER="2.1.0"
        ARCH=$(dpkg --print-architecture)
        case $ARCH in
            amd64) FFUF_ARCH="linux_amd64" ;;
            arm64) FFUF_ARCH="linux_arm64" ;;
            *) echo "Unsupported arch: $ARCH"; exit 0 ;;
        esac
        curl -sL "https://github.com/ffuf/ffuf/releases/download/v${FFUF_VER}/ffuf_${FFUF_VER}_${FFUF_ARCH}.tar.gz" -o /tmp/ffuf.tar.gz
        cd /tmp && tar xzf ffuf.tar.gz ffuf && mv ffuf /usr/local/bin/ && chmod 755 /usr/local/bin/ffuf
        rm -f /tmp/ffuf.tar.gz
    fi

    echo "==> Tools installed:"
    for tool in nmap nuclei ffuf sqlmap smbclient showmount curl openssl; do
        if command -v $tool &>/dev/null; then
            echo "  $tool: OK"
        else
            echo "  $tool: MISSING"
        fi
    done
TOOLS
fi

# First quick run
echo "==> Running quick security self-test..."
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S python3 /usr/lib/rusnas/sectest/sectest.py --quick" || true

echo ""
echo "==> sectest installed!"
echo "    Timer: monthly (1st of each month, 04:00)"
echo "    Full scan: ssh rusnas@${VM_HOST} 'sudo python3 /usr/lib/rusnas/sectest/sectest.py'"
echo "    Quick scan: ssh rusnas@${VM_HOST} 'sudo python3 /usr/lib/rusnas/sectest/sectest.py --quick'"
echo "    Results: /var/lib/rusnas/sectest-last.json"
echo "    Log: /var/log/rusnas/sectest.log"
