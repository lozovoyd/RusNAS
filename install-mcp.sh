#!/bin/bash
# Deploy MCP API backend for AI Assistant
set -e

VM="rusnas@10.10.10.72"
PASS="kl4389qd"
SSHPASS="sshpass -p '$PASS'"

SCP="sshpass -p $PASS scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"
SSH="sshpass -p $PASS ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no"

echo "→ Copying mcp-api.py to VM..."
$SCP cockpit/rusnas/scripts/mcp-api.py $VM:/tmp/mcp-api.py

echo "→ Installing mcp-api.py and configuring sudoers..."
$SSH $VM "
  echo '${PASS}' | sudo -S cp /tmp/mcp-api.py /usr/share/cockpit/rusnas/scripts/mcp-api.py &&
  echo '${PASS}' | sudo -S chmod 644 /usr/share/cockpit/rusnas/scripts/mcp-api.py &&
  echo '${PASS}' | sudo -S mkdir -p /var/log/rusnas &&
  echo '${PASS}' | sudo -S chmod 755 /var/log/rusnas &&
  echo '${PASS}' | sudo -S bash -c \"echo 'rusnas ALL=(ALL) NOPASSWD: /usr/bin/python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py *' > /etc/sudoers.d/rusnas-mcp\" &&
  echo '${PASS}' | sudo -S chmod 440 /etc/sudoers.d/rusnas-mcp &&
  echo '✓ sudoers configured'
"

echo ""
echo "✓ MCP API deployed successfully"
echo ""
echo "Test with:"
echo "  sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no $VM \\"
echo "    \"sudo python3 /usr/share/cockpit/rusnas/scripts/mcp-api.py get-status\""
