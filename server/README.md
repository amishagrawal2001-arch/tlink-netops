# NetOps Backend Server

Optional standalone backend server for large-scale network polling. Offloads SSH/SNMP polling from the Electron client to a centralized server.

## Why Use It?

- **100+ devices**: Client-side polling hits SSH connection limits
- **Multi-user**: Multiple NetOps clients share one polling server
- **Always-on**: Server polls 24/7 even when client app is closed
- **Secure**: SSH credentials stay on the server, not on laptops

## Quick Start

### Option 1: Direct Install (Linux)

```bash
# On your Linux server:
cd server/
./install.sh
```

This creates a systemd service that auto-starts on boot.

### Option 2: Docker

```bash
cd server/
docker compose up -d
```

### Option 3: Manual

```bash
cd server/
npm install
npm start
# Server runs on port 4000
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/status | Server health + client count |
| POST | /api/poll | Poll single device via SSH |
| POST | /api/poll-all | Poll multiple devices (concurrent) |
| POST | /api/backup | Backup device running config |
| POST | /api/discover | LLDP network discovery |

## WebSocket

Connect to `ws://server:4000` for real-time streaming:
- Poll results streamed as they complete
- No need to wait for all devices to finish

## Connecting from NetOps Client

1. Open NetOps desktop app
2. Settings → Backend Server URL: `http://<server-ip>:4000`
3. Click Connect
4. Polls now route through the backend server

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 4000 | Server port |
| NODE_ENV | production | Environment |

## Management

```bash
# Status
sudo systemctl status netops-server

# Logs
sudo journalctl -u netops-server -f

# Restart
sudo systemctl restart netops-server

# Stop
sudo systemctl stop netops-server
```
