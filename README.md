# Tlink NetOps

A GNS3-like network topology designer built on Electron + Angular. Design, visualize, and manage complex network topologies with a professional drag-and-drop SVG canvas, integrated terminal, SNMP polling, and more.

![CI](https://github.com/amishagrawal2001-arch/tlink-netops/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/amishagrawal2001-arch/tlink-netops/actions/workflows/release.yml/badge.svg)

---

## Screenshots

> _Screenshots coming soon. Drop your screenshots in a `docs/screenshots/` directory and link them here._

---

## Features

- **Interactive SVG Canvas** -- drag-and-drop topology editor with pan, zoom, and grid snapping
- **Device Library** -- routers, switches, firewalls, servers, cloud nodes, and custom devices
- **Link Management** -- create, style, and label connections between devices with waypoint support
- **Annotations** -- rectangles, ellipses, text labels, and embedded images on the canvas
- **Integrated Terminal** -- SSH terminal powered by xterm.js and node-pty
- **SNMP Polling** -- real-time device status via SNMP queries
- **Syslog Server** -- built-in syslog receiver for log collection
- **Inventory Export** -- export topology inventory to JSON
- **Undo / Redo** -- snapshot-based state management for all operations
- **Viewport Culling** -- performance optimization for large topologies (80+ nodes)
- **Multi-Select & Group Operations** -- rubber-band selection, bulk move, bulk delete
- **Context Menus** -- right-click context menus on nodes, links, and canvas
- **Keyboard Shortcuts** -- comprehensive shortcuts for power users
- **Cross-Platform** -- builds for macOS (.dmg), Windows (.exe), and Linux (.AppImage/.deb/.rpm)
- **CI/CD Pipelines** -- GitHub Actions for continuous integration and automated releases

---

## Installation

### Prerequisites

- Node.js 22+
- npm 9+
- Git

### Platform-Specific Dependencies

**macOS** -- no extra dependencies needed.

**Linux:**
```bash
sudo apt-get install -y build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev
```

**Windows** -- install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload.

### Quick Start

```bash
git clone git@github.com:amishagrawal2001-arch/tlink-netops.git
cd tlink-netops
npm install --legacy-peer-deps
npm run build
npm start
```

---

## Development Setup

```bash
# Clone the repository
git clone git@github.com:amishagrawal2001-arch/tlink-netops.git
cd tlink-netops

# Install dependencies
npm install --legacy-peer-deps

# Start in development mode with hot-reload
npm run dev
```

### Enabling Husky (Optional)

To enable Git hooks via Husky for automatic lint checks on commit:

```bash
npm install --save-dev husky --legacy-peer-deps
npx husky install
```

The `.husky/pre-commit` hook is already configured and will run lint checks automatically once Husky is installed.

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run build` | Build main process + renderer |
| `npm run build:main` | Build Electron main process only |
| `npm run build:renderer` | Build Angular renderer only |
| `npm start` | Launch the Electron app |
| `npm run dev` | Development mode with hot-reload |
| `npm run watch:main` | Watch and rebuild main process |
| `npm run watch:renderer` | Watch and rebuild renderer |
| `npm test` | Run all Jest tests |
| `npm run test:watch` | Run tests in watch mode |

---

## Project Structure

```
tlink-netops/
  app/src/                  # Electron main process (TypeScript)
    main.ts                 # App entry, window creation, IPC
    preload.ts              # Context bridge for renderer
    pty-manager.ts          # Terminal PTY management
    ipc-helpers.ts          # IPC handler utilities
    snmp-helpers.ts         # SNMP polling helpers
    syslog-server.ts        # Built-in syslog receiver
  renderer/src/             # Angular renderer (TypeScript)
    components/             # Angular components
      netops-canvas.*       # Main topology canvas (pug/scss/ts)
    services/               # Angular services
      topology.service      # Topology state management
      inventory.service     # Device inventory
    api/                    # Interfaces and API layer
    pipes/                  # Angular pipes (safeHtml, etc.)
  tests/                    # Jest test suites
  .github/workflows/        # CI and Release pipelines
  package.json              # Dependencies + electron-builder config
  tsconfig.main.json        # TypeScript config for main process
  tsconfig.renderer.json    # TypeScript config for renderer
  webpack.renderer.config.mjs  # Webpack config for Angular
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Ctrl/Cmd + A` | Select all |
| `Ctrl/Cmd + C` | Copy selection |
| `Ctrl/Cmd + V` | Paste |
| `Delete / Backspace` | Delete selection |
| `Ctrl/Cmd + S` | Save topology |
| `Ctrl/Cmd + O` | Open topology |
| `Ctrl/Cmd + N` | New topology |
| `Escape` | Deselect / cancel |
| `+` / `-` | Zoom in / out |
| `Ctrl/Cmd + 0` | Reset zoom |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, architecture notes, common issues, and CI/CD details.

---

## License

This project is licensed under the [MIT License](LICENSE).
