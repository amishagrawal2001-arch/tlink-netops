# Contributing to Tlink NetOps

## Development Setup

### Prerequisites
- Node.js 22+
- npm 9+
- Git

### macOS
```bash
# No extra dependencies needed
```

### Linux
```bash
sudo apt-get install -y build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev
```

### Windows
- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with C++ workload

### Install & Run
```bash
git clone git@github.com:amishagrawal2001-arch/tlink-netops.git
cd tlink-netops
npm install --legacy-peer-deps
npm run build
npm start
```

For development with hot-reload:
```bash
npm run dev
```

---

## Project Structure

```
tlink-netops/
  app/src/              # Electron main process (TypeScript)
    main.ts             # App entry, window creation, IPC
    preload.ts          # Context bridge for renderer
    pty-manager.ts      # Terminal PTY management
    ipc-helpers.ts      # IPC handler utilities
  renderer/src/         # Angular renderer (TypeScript)
    components/         # Angular components
      netops-canvas.*   # Main topology canvas (pug/scss/ts)
    services/           # Angular services
      topology.service  # Topology state management
      inventory.service # Device inventory
    api/                # Interfaces and API layer
    pipes/              # Angular pipes (safeHtml, etc.)
  tests/                # Jest test suites
  .github/workflows/    # CI and Release pipelines
  package.json          # Dependencies + electron-builder config
  tsconfig.main.json    # TypeScript config for main process
  tsconfig.renderer.json# TypeScript config for renderer
  webpack.renderer.config.mjs # Webpack config for Angular
```

---

## Key Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build main + renderer |
| `npm run build:main` | Build Electron main process only |
| `npm run build:renderer` | Build Angular renderer only |
| `npm start` | Launch the Electron app |
| `npm run dev` | Dev mode with hot-reload |
| `npm test` | Run all tests |
| `npm test -- --watch` | Run tests in watch mode |

---

## Workflow Guide

### 1. Git Setup (Do This First)

Always initialize git and create `.gitignore` before writing code:

```bash
git init
```

Create `.gitignore` with:
```
node_modules/
dist/
app/dist/
renderer/dist/
coverage/
*.log
*.topo.json
*-inv.json
.DS_Store
.claude/
```

**Commit early, commit often.** Missing config files (like `tsconfig.renderer.json`) cause CI failures that are hard to debug remotely.

### 2. npm Configuration

Create `.npmrc` in the project root to avoid peer dependency issues:
```
legacy-peer-deps=true
```

This ensures `npm install` works the same locally and on CI. Angular projects frequently have peer dependency conflicts between `@angular/*` packages and third-party libraries.

### 3. Dependency Management

- **`dependencies`** — Only packages needed at runtime in the packaged app (e.g., `node-pty`, `net-snmp`)
- **`devDependencies`** — Everything else: Angular, webpack, TypeScript, test tools, electron-builder

### 4. Pre-Push Checklist

Before pushing code:

- [ ] `npm run build` passes locally
- [ ] `npm test` runs (note any known failures)
- [ ] `git status` shows no untracked config files
- [ ] No secrets or credentials in code
- [ ] `.gitignore` excludes sensitive and generated files

---

## CI/CD Pipeline

### CI (runs on every push to main)

The CI workflow (`.github/workflows/ci.yml`) runs:
1. **Build** — Compiles TypeScript and bundles with webpack
2. **Test** — Runs Jest test suite

### Release (runs on version tags)

The Release workflow (`.github/workflows/release.yml`) builds installers:
- macOS: `.dmg` + `.zip`
- Windows: `.exe` (NSIS installer)
- Linux: `.AppImage` + `.deb` + `.rpm`

**To create a release:**
```bash
# Tag the version
git tag v1.0.0
git push origin v1.0.0

# This triggers the release workflow which:
# 1. Builds on macOS, Windows, and Linux runners
# 2. Creates a GitHub Release with all installers
```

---

## Common Issues & Fixes

### npm install fails with ERESOLVE

**Cause:** Angular peer dependency conflicts (e.g., `@ng-bootstrap` requires `@angular/localize`).

**Fix:** Use `--legacy-peer-deps`:
```bash
npm install --legacy-peer-deps
```
Or add to `.npmrc`:
```
legacy-peer-deps=true
```

### CI build fails: "file is missing from TypeScript compilation"

**Cause:** A config file (tsconfig, webpack config, etc.) wasn't committed to git.

**Fix:** Check `git status` for untracked files and commit them:
```bash
git status
git add tsconfig.renderer.json  # or whatever is missing
git commit -m "fix: add missing config file"
```

### CI fails: native module build error (node-pty, electron)

**Cause:** Missing system build tools on CI runner.

**Fix:** Add to CI workflow:
```yaml
- run: sudo apt-get update && sudo apt-get install -y build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev
```

For CI that only needs TypeScript compilation (not native modules):
```yaml
- run: npm install --legacy-peer-deps --ignore-optional
```

### GitHub Actions: "Node.js 20 actions are deprecated"

**Cause:** GitHub is deprecating Node.js 20 runners.

**Fix:** Add to workflow:
```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
```
And use Node.js 22+:
```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
```

### Drop event fires twice on canvas

**Cause:** Event bubbles from SVG canvas to parent shell container.

**Fix:** Add `ev.stopPropagation()` in the canvas drop handler.

### Context menu hidden by window border

**Cause:** Menu positioned without viewport bounds checking.

**Fix:** Clamp position:
```typescript
if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 16
if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 16
```

### SVG foreignObject blocks click events on layers below

**Cause:** HTML inside `foreignObject` creates its own stacking context that ignores SVG layer order.

**Fix:** Move interactive elements (labels, handles) to an overlay `<g>` rendered after the `foreignObject` in the SVG tree.

---

## Electron-Specific Notes

### Packaging Configuration

The `build` key in `package.json` configures electron-builder:
```json
"build": {
  "appId": "com.tlink.netops",
  "productName": "Tlink NetOps",
  "files": ["app/dist/**", "renderer/dist/**", "index.html"],
  "mac": { "category": "public.app-category.utilities" },
  "win": { "target": "nsis" },
  "linux": { "category": "Utility" }
}
```

### Code Signing

- **macOS:** Set `CSC_IDENTITY_AUTO_DISCOVERY: false` on CI to skip code signing. For production, use a Developer ID certificate.
- **Windows:** Use a code signing certificate for production builds.
- **Linux:** No code signing needed.

### Testing Locally

```bash
# Build the app
npm run build

# Package for your platform (without publishing)
npx electron-builder --mac --publish never    # macOS
npx electron-builder --win --publish never    # Windows
npx electron-builder --linux --publish never  # Linux

# Output goes to dist/ directory
```

---

## Architecture Notes

### SVG Canvas Rendering

The topology canvas uses SVG with these layers (bottom to top):
1. **Grid background** — configurable grid pattern
2. **Links layer** — link paths, colors, dashes
3. **Annotations layer** — shapes, text notes, images
4. **Nodes layer** — network devices
5. **Link endpoint overlay** — green connection handles
6. **Link labels overlay** — draggable label pills
7. **Waypoint handles** — link bend points
8. **Rubber band** — selection rectangle

### Performance Optimizations

- **Viewport culling** — only renders visible elements (activates at 80+ nodes)
- **Link path caching** — caches computed SVG paths, invalidates on position change
- **O(1) lookups** — Map-based node/link/annotation lookups instead of array.find()
- **requestAnimationFrame** — batched panning updates
- **trackBy** on all ngFor loops — prevents unnecessary DOM recreation

### State Management

- `TopologyService` manages all topology state with snapshot-based undo/redo
- Every mutation calls `_patch()` which snapshots the full topology
- Undo/redo works for all operations: nodes, links, shapes, labels, styles
