#!/bin/bash
# Deploy Cockpit rusnas plugin to VM
# Usage: ./deploy.sh

VM_HOST="10.10.10.72"
VM_USER="rusnas"
VM_PASS="kl4389qd"
REMOTE_PATH="/usr/share/cockpit/rusnas"
LOCAL_PATH="$(dirname "$0")/cockpit/rusnas"

SSH="sshpass -p ${VM_PASS} ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SCP="sshpass -p ${VM_PASS} scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "Deploying to ${VM_USER}@${VM_HOST}:${REMOTE_PATH} ..."

$SSH ${VM_USER}@${VM_HOST} "mkdir -p /tmp/rusnas-deploy/js /tmp/rusnas-deploy/css"
$SCP -r "${LOCAL_PATH}/"* "${VM_USER}@${VM_HOST}:/tmp/rusnas-deploy/"
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S cp -r /tmp/rusnas-deploy/* ${REMOTE_PATH}/ && echo '${VM_PASS}' | sudo -S chown -R root:root ${REMOTE_PATH}/ && echo '${VM_PASS}' | sudo -S find ${REMOTE_PATH} -type f -exec chmod 644 {} + && echo '${VM_PASS}' | sudo -S find ${REMOTE_PATH} -type d -exec chmod 755 {} + && rm -rf /tmp/rusnas-deploy/"

# Deploy Cockpit login branding
BRANDING_SRC="$(dirname "$0")/cockpit-branding/branding.css"
if [ -f "${BRANDING_SRC}" ]; then
  echo "Deploying login branding..."
  $SCP "${BRANDING_SRC}" "${VM_USER}@${VM_HOST}:/tmp/rusnas-branding.css"
  $SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S cp /tmp/rusnas-branding.css /usr/share/cockpit/branding/debian/branding.css && echo '${VM_PASS}' | sudo -S chmod 644 /usr/share/cockpit/branding/debian/branding.css"
fi

# Run quick security self-test if installed
if $SSH ${VM_USER}@${VM_HOST} "test -f /usr/lib/rusnas/sectest/sectest.py" 2>/dev/null; then
  echo "Running quick security self-test..."
  $SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S python3 /usr/lib/rusnas/sectest/sectest.py --quick 2>&1 | tail -5" || true
fi

echo "Done. Refresh Cockpit in the browser (http://${VM_HOST}:9090) to see changes."
