# Changelog

All notable changes to Tlink NetOps are documented in this file.

## [1.0.0] - 2026-03-26

### Added

- Comprehensive project setup script with 14 automation features (`35a2837`)
- Git remote setup, commit, and push automation in setup script (`061548a`)
- Project setup and CI/CD automation script (`3b94143`)
- CONTRIBUTING.md with workflow guide and .npmrc for peer deps (`f2849e9`)
- Release workflow for Mac, Windows, Linux installers (`cda71fc`)
- GitHub Actions CI workflow with build and test jobs (`eb5663a`)
- Comprehensive draw.io-style topology editor with full feature set (`82de1a7`)

### Fixed

- Missing tsconfig.renderer.json, tests, and terminal.html (`9a9f022`)
- npm install with --legacy-peer-deps for Angular peer conflicts (`27b6a52`)
- Skip optional native modules, use direct tsc/webpack commands (`7b144a9`)
- Install with full npm install and libsecret-1-dev (`685c665`)
- Node.js deprecation: use Node 22 + ignore-scripts for native deps (`b9b69c5`)

### Changed

- CI: add system deps for native modules (node-pty, electron) (`bede02b`)
- CI: separate build and test jobs, allow pre-existing test failures (`0967e08`)
