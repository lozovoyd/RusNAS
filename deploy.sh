#!/bin/bash
# Deploy Cockpit rusnas plugin to VM
# Usage: ./deploy.sh

VM_HOST="10.10.10.72"
VM_USER="rusnas"
REMOTE_PATH="/usr/share/cockpit/rusnas"
LOCAL_PATH="$(dirname "$0")/cockpit/rusnas"

echo "Deploying to ${VM_USER}@${VM_HOST}:${REMOTE_PATH} ..."

# Copy files to /tmp first (scp as rusnas), then sudo cp to final path
scp -o StrictHostKeyChecking=no -r "${LOCAL_PATH}/"* "${VM_USER}@${VM_HOST}:/tmp/rusnas-deploy/"
ssh -o StrictHostKeyChecking=no "${VM_USER}@${VM_HOST}" "sudo cp -r /tmp/rusnas-deploy/* ${REMOTE_PATH}/ && sudo chown -R root:root ${REMOTE_PATH}/ && rm -rf /tmp/rusnas-deploy/"

echo "Done. Refresh Cockpit in the browser to see changes."
