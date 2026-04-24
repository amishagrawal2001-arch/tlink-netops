#!/usr/bin/env bash
# NetOps Backend Server — Installation Script
# Pre-bundled: node_modules and dist/ included, no internet needed.
# Usage: ./install.sh

set -e

echo "=================================="
echo "  NetOps Backend Server Installer"
echo "=================================="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required. Install it first:"
    echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "   sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required (found $(node -v))"
    exit 1
fi

echo "✓ Node.js $(node -v)"

# Install directory
INSTALL_DIR="${NETOPS_DIR:-/opt/netops-server}"
echo "📁 Installing to: $INSTALL_DIR"

sudo mkdir -p "$INSTALL_DIR"
sudo chown "$(whoami):$(whoami)" "$INSTALL_DIR" 2>/dev/null || true

# Copy pre-bundled files (node_modules + dist included)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "📦 Copying files..."

if [ -d "$SCRIPT_DIR/dist" ] && [ -d "$SCRIPT_DIR/node_modules" ]; then
    # Pre-bundled — copy everything including node_modules and dist
    cp -r "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/src" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/dist" "$INSTALL_DIR/"
    cp -r "$SCRIPT_DIR/node_modules" "$INSTALL_DIR/"
    echo "   ✓ Using pre-bundled node_modules + dist (no internet needed)"
elif [ -d "$SCRIPT_DIR/src" ]; then
    # Source-only — need npm install + compile
    cp -r "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/src" "$INSTALL_DIR/"
    cd "$INSTALL_DIR"
    echo "   ⚠ No pre-bundled node_modules — running npm install..."
    npm install --production 2>&1 | tail -3
    echo "   ⚠ Compiling TypeScript..."
    npm install typescript 2>/dev/null
    npx tsc
    npm uninstall typescript 2>/dev/null
else
    echo "❌ Cannot find source files"
    exit 1
fi

# Create systemd service
echo "🔧 Creating systemd service..."
NODE_PATH="$(which node)"
sudo tee /etc/systemd/system/netops-server.service > /dev/null << EOF
[Unit]
Description=NetOps Backend Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=10
Environment=PORT=4000
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# Enable and (re)start — use `restart` so upgrading over an existing install
# picks up the new binary. `systemctl start` is a no-op when the unit is
# already running, which silently strands upgrades on the old code.
sudo systemctl daemon-reload
sudo systemctl enable netops-server
sudo systemctl restart netops-server

# Verify
sleep 2
if systemctl is-active --quiet netops-server; then
    STATUS="✅ RUNNING"
else
    STATUS="⚠️ Check logs: journalctl -u netops-server -f"
fi

echo ""
echo "=================================="
echo "  $STATUS"
echo "=================================="
echo ""
echo "  Status:  sudo systemctl status netops-server"
echo "  Logs:    sudo journalctl -u netops-server -f"
echo "  Stop:    sudo systemctl stop netops-server"
echo "  Restart: sudo systemctl restart netops-server"
echo ""
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo "  API:     http://${SERVER_IP}:4000/api/status"
echo "  Connect: NetOps app → Backend URL → http://${SERVER_IP}:4000"
echo ""
