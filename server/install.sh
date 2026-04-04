#!/usr/bin/env bash
# NetOps Backend Server — Remote Installation Script
# Usage: curl -sSL https://raw.githubusercontent.com/.../server/install.sh | bash
# Or: ./install.sh

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
    echo "❌ Node.js 18+ required (found v$(node -v))"
    exit 1
fi

echo "✓ Node.js $(node -v)"

# Install directory
INSTALL_DIR="${NETOPS_DIR:-/opt/netops-server}"
echo "📁 Installing to: $INSTALL_DIR"

sudo mkdir -p "$INSTALL_DIR"
sudo chown "$USER:$USER" "$INSTALL_DIR"

# Copy files
cp -r package.json tsconfig.json src/ "$INSTALL_DIR/"
cd "$INSTALL_DIR"

# Install dependencies
echo "📦 Installing dependencies..."
npm install --production 2>&1 | tail -1

# Compile TypeScript
echo "🔧 Compiling TypeScript..."
npx tsc

# Create systemd service
echo "🔧 Creating systemd service..."
sudo tee /etc/systemd/system/netops-server.service > /dev/null << EOF
[Unit]
Description=NetOps Backend Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) dist/index.js
Restart=on-failure
RestartSec=10
Environment=PORT=4000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable netops-server
sudo systemctl start netops-server

echo ""
echo "=================================="
echo "  ✅ NetOps Server Installed!"
echo "=================================="
echo ""
echo "  Status:  sudo systemctl status netops-server"
echo "  Logs:    sudo journalctl -u netops-server -f"
echo "  Stop:    sudo systemctl stop netops-server"
echo "  Restart: sudo systemctl restart netops-server"
echo ""
echo "  API:     http://$(hostname -I | awk '{print $1}'):4000/api/status"
echo "  Connect: In NetOps app → Settings → Backend URL → http://<this-server>:4000"
echo ""
