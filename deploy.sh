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
$SSH ${VM_USER}@${VM_HOST} "echo '${VM_PASS}' | sudo -S cp -r /tmp/rusnas-deploy/* ${REMOTE_PATH}/ && echo '${VM_PASS}' | sudo -S chown -R root:root ${REMOTE_PATH}/ && rm -rf /tmp/rusnas-deploy/"

echo "Done. Refresh Cockpit in the browser (http://${VM_HOST}:9090) to see changes."
