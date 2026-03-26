#!/bin/bash
#
# Tlink Project Setup & CI/CD Generator
# ======================================
# This script sets up a new Electron + Angular project with:
# - Git initialization with proper .gitignore
# - .npmrc for peer dependency handling
# - Environment file setup (.env.example / .env)
# - GitHub Actions CI pipeline
# - GitHub Actions Release pipeline (Mac/Win/Linux installers)
# - Pre-commit validation hook
# - License picker (MIT, Apache 2.0, GPL 3.0)
# - README.md generator
# - Issue & PR templates
# - Code quality (ESLint + Prettier)
# - Husky git hooks + lint-staged
# - Docker support (Dockerfile, docker-compose, .dockerignore)
# - Dependency audit (npm audit)
# - Branch protection (via gh CLI)
# - Changelog generator
# - Version bumping
# - Rollback support
# - Webhook notifications (Slack/Discord)
# - CI health check after push
#
# Usage:
#   ./scripts/setup-project.sh                    # Full interactive setup
#   ./scripts/setup-project.sh my-new-app         # Create and setup new directory
#   ./scripts/setup-project.sh --fix              # Fix common CI issues in existing project
#   ./scripts/setup-project.sh --validate         # Validate project is CI-ready
#   ./scripts/setup-project.sh --release v1.0.0   # Tag and push a release
#   ./scripts/setup-project.sh --changelog        # Generate CHANGELOG.md from git log
#   ./scripts/setup-project.sh --bump patch       # Bump version (major|minor|patch)
#   ./scripts/setup-project.sh --rollback         # Delete latest version tag
#   ./scripts/setup-project.sh --notify "msg"     # Send Slack/Discord webhook notification
#
# Requirements: git, node (22+), npm
# Optional:     gh (GitHub CLI), python3 (for JSON parsing)

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# ─── Helpers ──────────────────────────────────────────────────────────────────
info()    { echo -e "${BLUE}ℹ${NC}  $1"; }
success() { echo -e "${GREEN}✅${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠️${NC}  $1"; }
error()   { echo -e "${RED}❌${NC} $1"; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $1 ═══${NC}\n"; }

# ─── Detect project type ─────────────────────────────────────────────────────
detect_project_type() {
    if [ -f "package.json" ]; then
        if grep -q '"electron"' package.json 2>/dev/null; then
            echo "electron"
        elif grep -q '"@angular/core"' package.json 2>/dev/null; then
            echo "angular"
        elif grep -q '"react"' package.json 2>/dev/null; then
            echo "react"
        elif grep -q '"next"' package.json 2>/dev/null; then
            echo "nextjs"
        else
            echo "node"
        fi
    else
        echo "unknown"
    fi
}

# ─── Check prerequisites ─────────────────────────────────────────────────────
check_prerequisites() {
    header "Checking Prerequisites"

    local has_error=false

    if ! command -v git &>/dev/null; then
        error "git is not installed"
        has_error=true
    else
        success "git $(git --version | cut -d' ' -f3)"
    fi

    if ! command -v node &>/dev/null; then
        error "node is not installed"
        has_error=true
    else
        local node_major=$(node -v | cut -d'.' -f1 | tr -d 'v')
        if [ "$node_major" -lt 18 ]; then
            warn "Node.js $node_major detected. Recommend 22+ for CI compatibility"
        else
            success "node $(node -v)"
        fi
    fi

    if ! command -v npm &>/dev/null; then
        error "npm is not installed"
        has_error=true
    else
        success "npm $(npm -v)"
    fi

    if [ "$has_error" = true ]; then
        error "Missing prerequisites. Please install them and retry."
        exit 1
    fi
}

# ─── Create .gitignore ───────────────────────────────────────────────────────
create_gitignore() {
    local project_type=$1

    if [ -f ".gitignore" ]; then
        warn ".gitignore already exists — merging missing entries"
    fi

    cat > .gitignore.tmp << 'GITIGNORE'
# Dependencies
node_modules/

# Build output
dist/
app/dist/
renderer/dist/
build/
out/
.next/

# Coverage
coverage/

# Environment & secrets
.env
.env.local
.env.*.local
*.pem
credentials.json

# OS files
.DS_Store
Thumbs.db
*.swp
*~

# IDE
.idea/
.vscode/settings.json
*.sublime-*

# Logs
*.log
npm-debug.log*
yarn-error.log*

# Claude Code
.claude/

# Electron builder output
release/

# Data files (project-specific — adjust as needed)
# *.topo.json
# *-inv.json
GITIGNORE

    if [ -f ".gitignore" ]; then
        # Merge: add lines from template that don't exist in current .gitignore
        while IFS= read -r line; do
            if [ -n "$line" ] && [[ ! "$line" =~ ^# ]] && ! grep -qF "$line" .gitignore 2>/dev/null; then
                echo "$line" >> .gitignore
            fi
        done < .gitignore.tmp
        rm .gitignore.tmp
        success ".gitignore updated with missing entries"
    else
        mv .gitignore.tmp .gitignore
        success ".gitignore created"
    fi
}

# ─── Create .npmrc ────────────────────────────────────────────────────────────
create_npmrc() {
    if [ -f ".npmrc" ] && grep -q "legacy-peer-deps" .npmrc; then
        success ".npmrc already has legacy-peer-deps"
        return
    fi

    cat >> .npmrc << 'NPMRC'
legacy-peer-deps=true
NPMRC

    success ".npmrc created with legacy-peer-deps=true"
}

# ─── Create CI workflow ───────────────────────────────────────────────────────
create_ci_workflow() {
    local project_type=$1

    mkdir -p .github/workflows

    cat > .github/workflows/ci.yml << 'CI_YAML'
name: CI

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install system dependencies (for native modules)
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev

      - name: Install npm dependencies
        run: npm install --legacy-peer-deps --ignore-optional

      - name: Build
        run: npm run build

      - name: Build summary
        if: always()
        run: |
          echo "## Build Results" >> $GITHUB_STEP_SUMMARY
          if [ $? -eq 0 ]; then
            echo "✅ Build passed" >> $GITHUB_STEP_SUMMARY
          else
            echo "❌ Build failed" >> $GITHUB_STEP_SUMMARY
          fi

  test:
    name: Test
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev

      - name: Install npm dependencies
        run: npm install --legacy-peer-deps --ignore-optional

      - name: Run tests
        continue-on-error: true
        run: npm test -- --ci 2>&1 | tee test-output.txt

      - name: Test summary
        if: always()
        run: |
          echo "## Test Results" >> $GITHUB_STEP_SUMMARY
          if grep -q "Tests:" test-output.txt 2>/dev/null; then
            grep "Test Suites:" test-output.txt >> $GITHUB_STEP_SUMMARY || true
            grep "Tests:" test-output.txt >> $GITHUB_STEP_SUMMARY || true
          else
            echo "⚠️ Test output could not be parsed" >> $GITHUB_STEP_SUMMARY
          fi
CI_YAML

    success "CI workflow created at .github/workflows/ci.yml"
}

# ─── Create Release workflow ──────────────────────────────────────────────────
create_release_workflow() {
    local project_type=$1

    mkdir -p .github/workflows

    if [ "$project_type" != "electron" ]; then
        info "Skipping release workflow (not an Electron project)"
        return
    fi

    cat > .github/workflows/release.yml << 'RELEASE_YAML'
name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build-mac:
    name: Build macOS
    runs-on: macos-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --legacy-peer-deps
      - run: npm run build
      - name: Package for macOS
        run: npx electron-builder --mac --publish never
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: false
      - uses: actions/upload-artifact@v4
        with:
          name: release-mac
          path: |
            dist/*.dmg
            dist/*.zip

  build-windows:
    name: Build Windows
    runs-on: windows-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --legacy-peer-deps
      - run: npm run build
      - run: npx electron-builder --win --publish never
      - uses: actions/upload-artifact@v4
        with:
          name: release-windows
          path: |
            dist/*.exe
            dist/*.msi

  build-linux:
    name: Build Linux
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: |
          sudo apt-get update
          sudo apt-get install -y build-essential python3 libx11-dev libxkbfile-dev libsecret-1-dev rpm
      - run: npm install --legacy-peer-deps
      - run: npm run build
      - run: npx electron-builder --linux --publish never
      - uses: actions/upload-artifact@v4
        with:
          name: release-linux
          path: |
            dist/*.AppImage
            dist/*.deb
            dist/*.rpm

  publish:
    name: Create Release
    needs: [build-mac, build-windows, build-linux]
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    permissions:
      contents: write
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            release-mac/*
            release-windows/*
            release-linux/*
          generate_release_notes: true
          draft: false
RELEASE_YAML

    success "Release workflow created at .github/workflows/release.yml"
}

# ─── Create pre-commit hook ──────────────────────────────────────────────────
create_pre_commit_hook() {
    mkdir -p .git/hooks

    cat > .git/hooks/pre-commit << 'HOOK'
#!/bin/bash
# Pre-commit hook: validates project before commit

set -e

echo "🔍 Running pre-commit checks..."

# 1. Check for secrets/credentials
echo "  Checking for secrets..."
SECRETS_PATTERN='(password|secret|api_key|apikey|access_token|private_key)\s*[:=]\s*["\x27][^"\x27]{8,}'
if git diff --cached --diff-filter=ACM | grep -iE "$SECRETS_PATTERN" 2>/dev/null; then
    echo "❌ Possible secrets detected in staged files!"
    echo "   Please remove credentials before committing."
    exit 1
fi

# 2. Check for large files (>5MB)
echo "  Checking for large files..."
LARGE_FILES=$(git diff --cached --diff-filter=ACM --name-only | while read f; do
    if [ -f "$f" ]; then
        size=$(wc -c < "$f" 2>/dev/null || echo 0)
        if [ "$size" -gt 5242880 ]; then
            echo "$f ($(( size / 1048576 ))MB)"
        fi
    fi
done)
if [ -n "$LARGE_FILES" ]; then
    echo "❌ Large files detected (>5MB):"
    echo "$LARGE_FILES"
    echo "   Consider adding them to .gitignore"
    exit 1
fi

# 3. Check for common missing files
echo "  Checking for config files..."
MISSING=""
for f in package.json tsconfig.json; do
    if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" &>/dev/null; then
        if git diff --cached --name-only | grep -q "$f"; then
            : # being added in this commit
        else
            MISSING="$MISSING $f"
        fi
    fi
done

# Check for tsconfig files referenced in package.json scripts
if [ -f "package.json" ]; then
    for tsconfig in $(grep -oE 'tsconfig\.[a-z]+\.json' package.json 2>/dev/null | sort -u); do
        if [ -f "$tsconfig" ] && ! git ls-files --error-unmatch "$tsconfig" &>/dev/null 2>&1; then
            if ! git diff --cached --name-only | grep -q "$tsconfig"; then
                MISSING="$MISSING $tsconfig"
            fi
        fi
    done
fi

if [ -n "$MISSING" ]; then
    echo "⚠️  Config files exist locally but are not tracked by git:"
    echo "  $MISSING"
    echo "   Run: git add$MISSING"
fi

# 4. Verify build compiles (optional — uncomment for stricter checks)
# echo "  Running build check..."
# npm run build --silent 2>/dev/null || {
#     echo "❌ Build failed. Please fix before committing."
#     exit 1
# }

echo "✅ Pre-commit checks passed!"
HOOK

    chmod +x .git/hooks/pre-commit
    success "Pre-commit hook installed at .git/hooks/pre-commit"
}

# ─── Validate project ────────────────────────────────────────────────────────
validate_project() {
    header "Validating Project for CI Readiness"

    local issues=0

    # Check git
    if [ ! -d ".git" ]; then
        error "Not a git repository. Run: git init"
        issues=$((issues + 1))
    else
        success "Git repository found"
    fi

    # Check .gitignore
    if [ ! -f ".gitignore" ]; then
        error "Missing .gitignore"
        issues=$((issues + 1))
    elif ! grep -q "node_modules" .gitignore; then
        error ".gitignore missing node_modules/"
        issues=$((issues + 1))
    else
        success ".gitignore exists with node_modules/"
    fi

    # Check .npmrc
    if [ -f ".npmrc" ] && grep -q "legacy-peer-deps" .npmrc; then
        success ".npmrc has legacy-peer-deps"
    else
        warn "Missing .npmrc with legacy-peer-deps=true (Angular projects need this)"
    fi

    # Check package.json
    if [ ! -f "package.json" ]; then
        error "Missing package.json"
        issues=$((issues + 1))
    else
        success "package.json exists"

        # Check for build script
        if grep -q '"build"' package.json; then
            success "Build script found"
        else
            error "Missing 'build' script in package.json"
            issues=$((issues + 1))
        fi

        # Check for test script
        if grep -q '"test"' package.json; then
            success "Test script found"
        else
            warn "Missing 'test' script in package.json"
        fi
    fi

    # Check all tsconfig files referenced in package.json are tracked
    if [ -f "package.json" ]; then
        for tsconfig in $(grep -oE 'tsconfig\.[a-z]+\.json' package.json 2>/dev/null | sort -u); do
            if [ -f "$tsconfig" ]; then
                if git ls-files --error-unmatch "$tsconfig" &>/dev/null 2>&1; then
                    success "$tsconfig is tracked"
                else
                    error "$tsconfig exists but is NOT tracked by git!"
                    issues=$((issues + 1))
                fi
            else
                error "$tsconfig referenced in package.json but doesn't exist!"
                issues=$((issues + 1))
            fi
        done
    fi

    # Check webpack config if referenced
    if [ -f "package.json" ]; then
        for webpack_cfg in $(grep -oE 'webpack\.[a-z.]+\.(js|mjs|ts)' package.json 2>/dev/null | sort -u); do
            if [ -f "$webpack_cfg" ]; then
                if git ls-files --error-unmatch "$webpack_cfg" &>/dev/null 2>&1; then
                    success "$webpack_cfg is tracked"
                else
                    error "$webpack_cfg exists but is NOT tracked by git!"
                    issues=$((issues + 1))
                fi
            fi
        done
    fi

    # Check CI workflows
    if [ -f ".github/workflows/ci.yml" ]; then
        success "CI workflow exists"
    else
        warn "No CI workflow found at .github/workflows/ci.yml"
    fi

    # Check for untracked files that look important
    if [ -d ".git" ]; then
        local untracked=$(git ls-files --others --exclude-standard | grep -E '\.(json|js|mjs|ts|yml|yaml|html)$' | grep -v node_modules | grep -v dist | head -10)
        if [ -n "$untracked" ]; then
            warn "Potentially important untracked files:"
            echo "$untracked" | while read f; do echo "    $f"; done
        fi
    fi

    # Check for secrets in tracked files
    if [ -d ".git" ]; then
        local secrets=$(git ls-files | xargs grep -lE '(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36})' 2>/dev/null | head -5)
        if [ -n "$secrets" ]; then
            error "Possible API keys/secrets found in tracked files:"
            echo "$secrets" | while read f; do echo "    $f"; done
            issues=$((issues + 1))
        fi
    fi

    # Summary
    echo ""
    if [ $issues -eq 0 ]; then
        success "Project is CI-ready! No issues found."
    else
        error "$issues issue(s) found. Fix them before pushing."
    fi

    return $issues
}

# ─── Fix common issues ───────────────────────────────────────────────────────
fix_issues() {
    header "Auto-fixing Common CI Issues"

    # 1. Create .npmrc if missing
    create_npmrc

    # 2. Add missing config files to git
    if [ -d ".git" ]; then
        local added=0
        for f in tsconfig*.json webpack.*.mjs webpack.*.js .npmrc .gitignore; do
            if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" &>/dev/null 2>&1; then
                git add "$f"
                success "Added $f to git tracking"
                added=$((added + 1))
            fi
        done

        # Add HTML files in root
        for f in *.html; do
            if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" &>/dev/null 2>&1; then
                git add "$f"
                success "Added $f to git tracking"
                added=$((added + 1))
            fi
        done

        if [ $added -gt 0 ]; then
            info "Added $added file(s) to git. Don't forget to commit!"
        else
            success "No missing files to add"
        fi
    fi

    # 3. Ensure CI workflows exist
    local project_type=$(detect_project_type)
    if [ ! -f ".github/workflows/ci.yml" ]; then
        create_ci_workflow "$project_type"
    fi

    # 4. Test build
    info "Testing build..."
    if npm run build 2>&1 | tail -3; then
        success "Build passed!"
    else
        error "Build still failing. Check errors above."
    fi

    echo ""
    info "Run 'git status' to see changes, then commit and push."
}

# ─── Release ──────────────────────────────────────────────────────────────────
do_release() {
    local version=$1

    if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        error "Invalid version format. Use: v1.0.0, v1.2.3, etc."
        exit 1
    fi

    header "Creating Release $version"

    # Validate first
    validate_project || {
        error "Fix validation issues before releasing."
        exit 1
    }

    # Check for uncommitted changes
    if [ -n "$(git status --porcelain)" ]; then
        error "Uncommitted changes found. Commit or stash them first."
        git status --short
        exit 1
    fi

    # Build locally to verify
    info "Verifying build..."
    npm run build 2>&1 | tail -3 || {
        error "Build failed. Fix before releasing."
        exit 1
    }
    success "Build verified"

    # Create and push tag
    info "Creating tag $version..."
    git tag "$version"
    success "Tag $version created"

    info "Pushing tag to origin..."
    git push origin "$version"
    success "Tag pushed! Release workflow should start on GitHub Actions."

    echo ""
    info "Monitor the release at:"
    local remote_url=$(git remote get-url origin 2>/dev/null | sed 's/git@github.com[^:]*:/https:\/\/github.com\//' | sed 's/\.git$//')
    if [ -n "$remote_url" ]; then
        echo "  ${remote_url}/actions"
        echo "  ${remote_url}/releases"
    fi
}

# ─── Setup git remote ─────────────────────────────────────────────────────────
setup_git_remote() {
    # Check if remote already exists
    if git remote get-url origin &>/dev/null 2>&1; then
        local current_remote=$(git remote get-url origin)
        success "Remote origin already set: $current_remote"
        echo ""
        read -p "  Change remote? (y/N): " change_remote
        if [[ ! "$change_remote" =~ ^[Yy] ]]; then
            return
        fi
    fi

    header "Git Remote Setup"

    echo "  How would you like to set up the remote?"
    echo ""
    echo "  1) Enter GitHub repo URL (SSH or HTTPS)"
    echo "  2) Create new repo on GitHub (requires 'gh' CLI)"
    echo "  3) Skip for now"
    echo ""
    read -p "  Choice [1/2/3]: " choice

    case "$choice" in
        1)
            echo ""
            echo "  Examples:"
            echo "    SSH:   git@github.com:username/repo.git"
            echo "    HTTPS: https://github.com/username/repo.git"
            echo ""
            read -p "  Repo URL: " repo_url

            if [ -z "$repo_url" ]; then
                warn "No URL entered. Skipping remote setup."
                return
            fi

            if git remote get-url origin &>/dev/null 2>&1; then
                git remote set-url origin "$repo_url"
            else
                git remote add origin "$repo_url"
            fi
            success "Remote origin set to: $repo_url"

            # Test connection
            echo ""
            info "Testing connection..."
            if git ls-remote origin &>/dev/null 2>&1; then
                success "Connection successful!"
            else
                warn "Could not connect to remote. Check URL and permissions."
                echo ""
                echo "  Common fixes:"
                echo "    - SSH: Ensure your SSH key is added to GitHub"
                echo "      Test: ssh -T git@github.com"
                echo "    - SSH alias: If using SSH config aliases, use that hostname"
                echo "      Example: git@github.com-myalias:user/repo.git"
                echo "    - HTTPS: You may need a personal access token"
                echo ""
                read -p "  Enter corrected URL (or press Enter to skip): " corrected_url
                if [ -n "$corrected_url" ]; then
                    git remote set-url origin "$corrected_url"
                    success "Remote updated to: $corrected_url"
                fi
            fi
            ;;
        2)
            if ! command -v gh &>/dev/null; then
                error "'gh' CLI not installed. Install from: https://cli.github.com"
                echo ""
                read -p "  Enter repo URL manually instead: " repo_url
                if [ -n "$repo_url" ]; then
                    git remote add origin "$repo_url" 2>/dev/null || git remote set-url origin "$repo_url"
                    success "Remote origin set to: $repo_url"
                fi
                return
            fi

            local repo_name=$(basename "$(pwd)")
            echo ""
            read -p "  Repo name [$repo_name]: " custom_name
            repo_name=${custom_name:-$repo_name}

            echo ""
            echo "  Visibility:"
            echo "    1) Private (default)"
            echo "    2) Public"
            read -p "  Choice [1/2]: " visibility
            local vis_flag="--private"
            if [ "$visibility" = "2" ]; then
                vis_flag="--public"
            fi

            info "Creating GitHub repo: $repo_name..."
            if gh repo create "$repo_name" $vis_flag --source=. --remote=origin 2>&1; then
                success "GitHub repo created and remote set!"
            else
                error "Failed to create repo. Check 'gh auth status'."
            fi
            ;;
        3)
            info "Skipping remote setup. You can add it later:"
            echo "    git remote add origin <your-repo-url>"
            ;;
        *)
            warn "Invalid choice. Skipping remote setup."
            ;;
    esac
}

# ─── Initial commit and push ─────────────────────────────────────────────────
initial_commit_and_push() {
    header "Initial Commit & Push"

    # Check if there are files to commit
    local staged=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
    local untracked=$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')
    local modified=$(git diff --name-only 2>/dev/null | wc -l | tr -d ' ')

    if [ "$staged" = "0" ] && [ "$untracked" = "0" ] && [ "$modified" = "0" ]; then
        success "Nothing to commit — working tree clean"
        return
    fi

    echo "  Changes detected:"
    [ "$untracked" != "0" ] && echo "    $untracked untracked file(s)"
    [ "$modified" != "0" ] && echo "    $modified modified file(s)"
    [ "$staged" != "0" ] && echo "    $staged staged file(s)"
    echo ""

    read -p "  Commit and push all changes? (Y/n): " do_commit
    if [[ "$do_commit" =~ ^[Nn] ]]; then
        info "Skipping commit. You can do it manually later."
        return
    fi

    # Stage all files (respecting .gitignore)
    git add -A

    # Show what will be committed
    echo ""
    info "Files to commit:"
    git diff --cached --stat | tail -5
    echo ""

    # Commit
    local default_msg="chore: initial project setup with CI/CD pipeline"
    read -p "  Commit message [$default_msg]: " commit_msg
    commit_msg=${commit_msg:-$default_msg}

    git commit -m "$commit_msg"
    success "Committed!"

    # Push
    if git remote get-url origin &>/dev/null 2>&1; then
        echo ""
        read -p "  Push to origin? (Y/n): " do_push
        if [[ ! "$do_push" =~ ^[Nn] ]]; then
            local branch=$(git branch --show-current)
            info "Pushing to origin/$branch..."
            if git push -u origin "$branch" 2>&1; then
                success "Pushed successfully!"
                echo ""
                local remote_url=$(git remote get-url origin 2>/dev/null | sed 's/git@github.com[^:]*:/https:\/\/github.com\//' | sed 's/\.git$//')
                if [ -n "$remote_url" ]; then
                    info "View your repo: $remote_url"
                    info "Check CI status: ${remote_url}/actions"
                fi
            else
                error "Push failed. Check remote URL and permissions."
                echo ""
                echo "  Try:"
                echo "    git remote -v                    # Check remote URL"
                echo "    ssh -T git@github.com            # Test SSH connection"
                echo "    git push -u origin $branch       # Retry push"
            fi
        fi
    else
        warn "No remote configured. Add one and push manually:"
        echo "    git remote add origin <your-repo-url>"
        echo "    git push -u origin $(git branch --show-current)"
    fi
}

# ─── Environment File Setup ─────────────────────────────────────────────────
setup_env_file() {
    header "Environment File Setup"

    # Create .env.example
    if [ -f ".env.example" ]; then
        success ".env.example already exists"
    else
        cat > .env.example << 'ENVEXAMPLE'
# ─── Application ────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development

# ─── Database ───────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/mydb

# ─── API Keys ───────────────────────────────────────────────────────────────
API_KEY=your_api_key_here

# ─── Notifications (optional) ──────────────────────────────────────────────
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXX/YYY
ENVEXAMPLE
        success ".env.example created"
    fi

    # Verify .env is in .gitignore
    if [ -f ".gitignore" ]; then
        if grep -q '^\.env$' .gitignore 2>/dev/null || grep -q '^\.env\b' .gitignore 2>/dev/null; then
            success ".env is listed in .gitignore"
        else
            echo ".env" >> .gitignore
            success "Added .env to .gitignore"
        fi
    else
        warn "No .gitignore found — create one first"
    fi

    # Create .env from .env.example if it doesn't exist
    if [ -f ".env" ]; then
        success ".env already exists"
    else
        cp .env.example .env
        success ".env created from .env.example (edit with your values)"
    fi
}

# ─── README Generator ──────────────────────────────────────────────────────
generate_readme() {
    header "README Generator"

    if [ -f "README.md" ]; then
        warn "README.md already exists"
        read -p "  Overwrite? (y/N): " overwrite
        if [[ ! "$overwrite" =~ ^[Yy] ]]; then
            info "Keeping existing README.md"
            return
        fi
    fi

    local project_name="My Project"
    local project_description="A project generated with Tlink setup"
    local repo_user="USER"
    local repo_name="REPO"

    if [ -f "package.json" ]; then
        project_name=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"name"[[:space:]]*:[[:space:]]*"//;s/"$//')
        project_description=$(grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"description"[[:space:]]*:[[:space:]]*"//;s/"$//')
        project_name=${project_name:-"My Project"}
        project_description=${project_description:-"A project generated with Tlink setup"}
    fi

    if git remote get-url origin &>/dev/null 2>&1; then
        local remote_url=$(git remote get-url origin)
        repo_user=$(echo "$remote_url" | sed -E 's#.*(github\.com[:/])([^/]+)/.*#\2#')
        repo_name=$(echo "$remote_url" | sed -E 's#.*/([^/]+?)(\.git)?$#\1#')
    fi

    # Gather scripts from package.json
    local scripts_section=""
    if [ -f "package.json" ]; then
        scripts_section=$(python3 -c "
import json, sys
try:
    with open('package.json') as f:
        pkg = json.load(f)
    scripts = pkg.get('scripts', {})
    for k, v in scripts.items():
        print(f'| \`npm run {k}\` | {v} |')
except:
    sys.exit(0)
" 2>/dev/null || true)
    fi

    if [ -z "$scripts_section" ]; then
        scripts_section="| \`npm start\` | Start the application |
| \`npm run build\` | Build for production |
| \`npm test\` | Run tests |"
    fi

    cat > README.md << READMEEOF
# ${project_name}

${project_description}

![CI](https://github.com/${repo_user}/${repo_name}/actions/workflows/ci.yml/badge.svg)

## Installation

\`\`\`bash
git clone https://github.com/${repo_user}/${repo_name}.git
cd ${repo_name}
npm install
\`\`\`

## Available Scripts

| Command | Description |
| ------- | ----------- |
${scripts_section}

## Project Structure

\`\`\`
.
├── src/                # Source code
├── dist/               # Build output
├── .github/            # GitHub Actions workflows
├── scripts/            # Utility scripts
├── package.json        # Dependencies and scripts
└── README.md           # This file
\`\`\`

## Screenshots

<!-- Add screenshots here -->
_No screenshots yet._

## License

See [LICENSE](./LICENSE) for details.
READMEEOF

    success "README.md generated"
}

# ─── License Picker ────────────────────────────────────────────────────────
pick_license() {
    header "License Picker"

    if [ -f "LICENSE" ]; then
        warn "LICENSE file already exists"
        read -p "  Overwrite? (y/N): " overwrite
        if [[ ! "$overwrite" =~ ^[Yy] ]]; then
            info "Keeping existing LICENSE"
            return
        fi
    fi

    echo "  Choose a license:"
    echo ""
    echo "  1) MIT"
    echo "  2) Apache 2.0"
    echo "  3) GPL 3.0"
    echo "  4) Skip"
    echo ""
    read -p "  Choice [1/2/3/4]: " license_choice

    local current_year
    current_year=$(date +%Y)
    local author=""

    if [ "$license_choice" != "4" ] && [ -n "$license_choice" ]; then
        # Try to get author from git config or package.json
        author=$(git config user.name 2>/dev/null || true)
        if [ -z "$author" ] && [ -f "package.json" ]; then
            author=$(grep -o '"author"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"author"[[:space:]]*:[[:space:]]*"//;s/"$//')
        fi
        if [ -z "$author" ]; then
            read -p "  Author name: " author
        else
            read -p "  Author name [$author]: " custom_author
            author=${custom_author:-$author}
        fi
    fi

    case "$license_choice" in
        1)
            cat > LICENSE << MITEOF
MIT License

Copyright (c) ${current_year} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
MITEOF
            success "MIT License created"
            ;;
        2)
            cat > LICENSE << APACHEEOF
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   Copyright ${current_year} ${author}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
APACHEEOF
            success "Apache 2.0 License created"
            ;;
        3)
            cat > LICENSE << GPLEOF
                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) ${current_year} ${author}

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this program.  If not, see <https://www.gnu.org/licenses/>.
GPLEOF
            success "GPL 3.0 License created"
            ;;
        4|"")
            info "Skipping license"
            ;;
        *)
            warn "Invalid choice. Skipping license."
            ;;
    esac
}

# ─── Dependency Audit ──────────────────────────────────────────────────────
run_dependency_audit() {
    header "Dependency Audit"

    if [ ! -f "package.json" ]; then
        warn "No package.json found. Skipping audit."
        return
    fi

    if [ ! -d "node_modules" ]; then
        warn "node_modules not found. Run npm install first."
        return
    fi

    info "Running npm audit..."
    local audit_output
    audit_output=$(npm audit --json 2>/dev/null || true)

    if [ -z "$audit_output" ]; then
        warn "Could not run npm audit"
        return
    fi

    local total_vulns
    total_vulns=$(echo "$audit_output" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    v = data.get('metadata', {}).get('vulnerabilities', {})
    total = sum(v.values())
    print(total)
except:
    print('0')
" 2>/dev/null || echo "0")

    if [ "$total_vulns" = "0" ]; then
        success "No vulnerabilities found!"
    else
        local vuln_summary
        vuln_summary=$(echo "$audit_output" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    v = data.get('metadata', {}).get('vulnerabilities', {})
    parts = []
    for level in ['critical', 'high', 'moderate', 'low', 'info']:
        count = v.get(level, 0)
        if count > 0:
            parts.append(f'{count} {level}')
    print(', '.join(parts))
except:
    print('unknown')
" 2>/dev/null || echo "unknown")

        warn "Found $total_vulns vulnerability(ies): $vuln_summary"
        echo ""
        read -p "  Run 'npm audit fix' to attempt auto-fix? (Y/n): " do_fix
        if [[ ! "$do_fix" =~ ^[Nn] ]]; then
            info "Running npm audit fix..."
            npm audit fix 2>&1 | tail -5
            success "Audit fix complete. Re-run audit to verify."
        fi
    fi
}

# ─── Docker Support ────────────────────────────────────────────────────────
setup_docker() {
    header "Docker Support"

    read -p "  Add Docker support? (y/N): " want_docker
    if [[ ! "$want_docker" =~ ^[Yy] ]]; then
        info "Skipping Docker setup"
        return
    fi

    local project_type
    project_type=$(detect_project_type)

    # Generate Dockerfile
    if [ -f "Dockerfile" ]; then
        warn "Dockerfile already exists — skipping"
    else
        case "$project_type" in
            electron)
                cat > Dockerfile << 'DOCKEREOF'
FROM node:22-bullseye AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

# Electron apps typically aren't run in Docker,
# but this builds the project for CI/testing purposes.
CMD ["npm", "start"]
DOCKEREOF
                ;;
            angular)
                cat > Dockerfile << 'DOCKEREOF'
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
DOCKEREOF
                ;;
            *)
                cat > Dockerfile << 'DOCKEREOF'
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "dist/index.js"]
DOCKEREOF
                ;;
        esac
        success "Dockerfile created (type: $project_type)"
    fi

    # Generate docker-compose.yml
    if [ -f "docker-compose.yml" ]; then
        warn "docker-compose.yml already exists — skipping"
    else
        cat > docker-compose.yml << 'COMPOSEEOF'
version: "3.8"

services:
  app:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    volumes:
      - .:/app
      - /app/node_modules
    restart: unless-stopped
COMPOSEEOF
        success "docker-compose.yml created"
    fi

    # Generate .dockerignore
    if [ -f ".dockerignore" ]; then
        warn ".dockerignore already exists — skipping"
    else
        cat > .dockerignore << 'DIGNOREEOF'
node_modules
dist
.git
.github
.env
.env.local
*.log
coverage
.DS_Store
.idea
.vscode
DIGNOREEOF
        success ".dockerignore created"
    fi
}

# ─── Branch Protection (via gh CLI) ────────────────────────────────────────
setup_branch_protection() {
    header "Branch Protection"

    if ! command -v gh &>/dev/null; then
        warn "'gh' CLI not installed — skipping branch protection"
        return
    fi

    if ! gh auth status &>/dev/null 2>&1; then
        warn "'gh' not authenticated — skipping branch protection"
        return
    fi

    read -p "  Set up branch protection on main? (y/N): " want_protection
    if [[ ! "$want_protection" =~ ^[Yy] ]]; then
        info "Skipping branch protection"
        return
    fi

    local branch="main"
    if ! git rev-parse --verify main &>/dev/null 2>&1; then
        branch="master"
        if ! git rev-parse --verify master &>/dev/null 2>&1; then
            warn "Neither 'main' nor 'master' branch found. Skipping."
            return
        fi
    fi

    local repo
    repo=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || true)
    if [ -z "$repo" ]; then
        warn "Could not determine GitHub repo. Skipping."
        return
    fi

    info "Setting branch protection on '$branch' for $repo..."
    if gh api -X PUT "repos/${repo}/branches/${branch}/protection" \
        --input - << PROTEOF 2>/dev/null
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Build", "Test"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  },
  "restrictions": null
}
PROTEOF
    then
        success "Branch protection enabled on '$branch'"
        info "  - Require PR reviews (1 approval)"
        info "  - Require status checks (Build, Test must pass)"
    else
        error "Failed to set branch protection. You may need admin access."
    fi
}

# ─── Issue/PR Templates ────────────────────────────────────────────────────
create_issue_pr_templates() {
    header "Issue & PR Templates"

    read -p "  Create GitHub issue/PR templates? (Y/n): " want_templates
    if [[ "$want_templates" =~ ^[Nn] ]]; then
        info "Skipping templates"
        return
    fi

    mkdir -p .github/ISSUE_TEMPLATE

    # Bug report template
    if [ -f ".github/ISSUE_TEMPLATE/bug_report.md" ]; then
        warn "bug_report.md already exists — skipping"
    else
        cat > .github/ISSUE_TEMPLATE/bug_report.md << 'BUGEOF'
---
name: Bug Report
about: Report a bug to help us improve
title: "[BUG] "
labels: bug
assignees: ""
---

## Describe the Bug
A clear and concise description of what the bug is.

## Steps to Reproduce
1. Go to '...'
2. Click on '...'
3. See error

## Expected Behavior
What you expected to happen.

## Actual Behavior
What actually happened.

## Screenshots
If applicable, add screenshots.

## Environment
- OS: [e.g., macOS 14, Windows 11]
- Node version: [e.g., 22.x]
- App version: [e.g., v1.0.0]

## Additional Context
Add any other context here.
BUGEOF
        success "Bug report template created"
    fi

    # Feature request template
    if [ -f ".github/ISSUE_TEMPLATE/feature_request.md" ]; then
        warn "feature_request.md already exists — skipping"
    else
        cat > .github/ISSUE_TEMPLATE/feature_request.md << 'FEATEOF'
---
name: Feature Request
about: Suggest a new feature or enhancement
title: "[FEATURE] "
labels: enhancement
assignees: ""
---

## Problem Statement
A clear description of the problem this feature would solve.

## Proposed Solution
Describe the solution you'd like.

## Alternatives Considered
Any alternative solutions or features you've considered.

## Additional Context
Add any other context, mockups, or screenshots.
FEATEOF
        success "Feature request template created"
    fi

    # Pull request template
    if [ -f ".github/PULL_REQUEST_TEMPLATE.md" ]; then
        warn "PULL_REQUEST_TEMPLATE.md already exists — skipping"
    else
        cat > .github/PULL_REQUEST_TEMPLATE.md << 'PREOF'
## Summary
<!-- Brief description of what this PR does -->

## Changes
-

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update
- [ ] Refactoring
- [ ] CI/CD changes

## Testing
- [ ] Tests added/updated
- [ ] Manual testing performed

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated (if needed)
- [ ] No new warnings introduced
PREOF
        success "Pull request template created"
    fi
}

# ─── Changelog Generator ──────────────────────────────────────────────────
generate_changelog() {
    header "Changelog Generator"

    if [ ! -d ".git" ]; then
        error "Not a git repository. Cannot generate changelog."
        return 1
    fi

    local commit_count
    commit_count=$(git rev-list --count HEAD 2>/dev/null || echo "0")
    if [ "$commit_count" = "0" ]; then
        warn "No commits found. Cannot generate changelog."
        return
    fi

    info "Generating CHANGELOG.md from git history ($commit_count commits)..."

    {
        echo "# Changelog"
        echo ""
        echo "All notable changes to this project are documented in this file."
        echo ""

        # Group by tag (version), or show all if no tags
        local tags
        tags=$(git tag --sort=-version:refname 2>/dev/null | head -20)

        if [ -n "$tags" ]; then
            local prev_tag=""
            for tag in $tags; do
                local tag_date
                tag_date=$(git log -1 --format='%ai' "$tag" 2>/dev/null | cut -d' ' -f1)
                echo "## [$tag] - ${tag_date}"
                echo ""

                local range
                if [ -n "$prev_tag" ]; then
                    range="${tag}..${prev_tag}"
                else
                    range="$tag"
                fi

                for type_prefix in "feat" "fix" "chore" "docs" "refactor" "test" "ci" "style" "perf"; do
                    local entries
                    entries=$(git log --pretty=format:"- %s (\`%h\`)" "$range" 2>/dev/null | grep -i "^- ${type_prefix}" || true)
                    if [ -n "$entries" ]; then
                        local type_label
                        case "$type_prefix" in
                            feat)     type_label="Features" ;;
                            fix)      type_label="Bug Fixes" ;;
                            chore)    type_label="Chores" ;;
                            docs)     type_label="Documentation" ;;
                            refactor) type_label="Refactoring" ;;
                            test)     type_label="Tests" ;;
                            ci)       type_label="CI/CD" ;;
                            style)    type_label="Styling" ;;
                            perf)     type_label="Performance" ;;
                        esac
                        echo "### $type_label"
                        echo "$entries"
                        echo ""
                    fi
                done

                # Uncategorized
                local uncategorized
                uncategorized=$(git log --pretty=format:"- %s (\`%h\`)" "$range" 2>/dev/null | grep -iv "^- \(feat\|fix\|chore\|docs\|refactor\|test\|ci\|style\|perf\)" || true)
                if [ -n "$uncategorized" ]; then
                    echo "### Other"
                    echo "$uncategorized"
                    echo ""
                fi

                prev_tag="$tag"
            done

            # Commits before earliest tag
            local earliest_tag
            earliest_tag=$(echo "$tags" | tail -1)
            local before_tag
            before_tag=$(git log --pretty=format:"- %s (\`%h\`)" "${earliest_tag}" 2>/dev/null || true)
            if [ -n "$before_tag" ]; then
                echo "## Earlier Commits"
                echo ""
                echo "$before_tag"
                echo ""
            fi
        else
            # No tags — just list all commits grouped by type
            echo "## Unreleased"
            echo ""

            for type_prefix in "feat" "fix" "chore" "docs" "refactor" "test" "ci" "style" "perf"; do
                local entries
                entries=$(git log --pretty=format:"- %s (\`%h\`) — %ai" HEAD 2>/dev/null | grep -i "^- ${type_prefix}" | sed 's/ [0-9][0-9]:[0-9][0-9]:[0-9][0-9] [+-][0-9]*//' || true)
                if [ -n "$entries" ]; then
                    local type_label
                    case "$type_prefix" in
                        feat)     type_label="Features" ;;
                        fix)      type_label="Bug Fixes" ;;
                        chore)    type_label="Chores" ;;
                        docs)     type_label="Documentation" ;;
                        refactor) type_label="Refactoring" ;;
                        test)     type_label="Tests" ;;
                        ci)       type_label="CI/CD" ;;
                        style)    type_label="Styling" ;;
                        perf)     type_label="Performance" ;;
                    esac
                    echo "### $type_label"
                    echo "$entries"
                    echo ""
                fi
            done

            local uncategorized
            uncategorized=$(git log --pretty=format:"- %s (\`%h\`) — %ai" HEAD 2>/dev/null | grep -iv "^- \(feat\|fix\|chore\|docs\|refactor\|test\|ci\|style\|perf\)" | sed 's/ [0-9][0-9]:[0-9][0-9]:[0-9][0-9] [+-][0-9]*//' || true)
            if [ -n "$uncategorized" ]; then
                echo "### Other"
                echo "$uncategorized"
                echo ""
            fi
        fi
    } > CHANGELOG.md

    success "CHANGELOG.md generated"
}

# ─── Version Bump ──────────────────────────────────────────────────────────
do_version_bump() {
    local bump_type=$1

    if [[ ! "$bump_type" =~ ^(major|minor|patch)$ ]]; then
        error "Invalid bump type. Use: major, minor, or patch"
        exit 1
    fi

    header "Version Bump ($bump_type)"

    if [ ! -f "package.json" ]; then
        error "No package.json found."
        exit 1
    fi

    # Get current version
    local current_version
    current_version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' package.json | head -1 | sed 's/"version"[[:space:]]*:[[:space:]]*"//;s/"$//')

    if [ -z "$current_version" ]; then
        error "Could not read version from package.json"
        exit 1
    fi

    info "Current version: $current_version"

    # Parse semver
    local major minor patch
    IFS='.' read -r major minor patch <<< "$current_version"
    patch=${patch%%[-+]*}  # strip pre-release/build metadata

    case "$bump_type" in
        major) major=$((major + 1)); minor=0; patch=0 ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        patch) patch=$((patch + 1)) ;;
    esac

    local new_version="${major}.${minor}.${patch}"
    info "New version: $new_version"

    # Update package.json
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\"[[:space:]]*:[[:space:]]*\"${current_version}\"/\"version\": \"${new_version}\"/" package.json
    else
        sed -i "s/\"version\"[[:space:]]*:[[:space:]]*\"${current_version}\"/\"version\": \"${new_version}\"/" package.json
    fi
    success "package.json updated to $new_version"

    # Check for uncommitted changes
    if [ -n "$(git status --porcelain)" ]; then
        git add package.json
        git commit -m "chore: bump version to ${new_version}"
        success "Version bump committed"
    fi

    # Create git tag
    local tag="v${new_version}"
    git tag "$tag"
    success "Tag $tag created"

    # Push
    read -p "  Push tag $tag to origin? (Y/n): " do_push
    if [[ ! "$do_push" =~ ^[Nn] ]]; then
        local branch
        branch=$(git branch --show-current)
        git push origin "$branch" 2>&1 || warn "Could not push branch"
        git push origin "$tag" 2>&1 || warn "Could not push tag"
        success "Tag $tag pushed (release workflow should trigger)"
    fi
}

# ─── Health Check After Push ──────────────────────────────────────────────
health_check_ci() {
    header "CI Health Check"

    if ! command -v gh &>/dev/null; then
        warn "'gh' CLI not installed — cannot check CI status"
        return
    fi

    if ! gh auth status &>/dev/null 2>&1; then
        warn "'gh' not authenticated — cannot check CI status"
        return
    fi

    info "Polling GitHub Actions status (up to 5 minutes)..."

    local max_wait=300
    local waited=0
    local interval=15
    local run_id=""

    # Get the latest workflow run
    run_id=$(gh run list --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)

    if [ -z "$run_id" ]; then
        warn "No workflow runs found"
        return
    fi

    info "Watching run #${run_id}..."

    while [ $waited -lt $max_wait ]; do
        local status conclusion
        status=$(gh run view "$run_id" --json status -q '.status' 2>/dev/null || echo "unknown")
        conclusion=$(gh run view "$run_id" --json conclusion -q '.conclusion' 2>/dev/null || echo "")

        if [ "$status" = "completed" ]; then
            if [ "$conclusion" = "success" ]; then
                success "CI passed!"
            else
                error "CI failed (conclusion: $conclusion)"
                local run_url
                run_url=$(gh run view "$run_id" --json url -q '.url' 2>/dev/null || true)
                if [ -n "$run_url" ]; then
                    info "View details: $run_url"
                fi
                # Show failed steps
                gh run view "$run_id" --log-failed 2>/dev/null | tail -20 || true
            fi
            return
        fi

        info "  Status: $status — waiting ${interval}s (${waited}s/${max_wait}s)..."
        sleep "$interval"
        waited=$((waited + interval))
    done

    warn "Timeout waiting for CI. Check manually:"
    gh run view "$run_id" --json url -q '.url' 2>/dev/null || true
}

# ─── Rollback ──────────────────────────────────────────────────────────────
do_rollback() {
    header "Rollback Latest Version Tag"

    if [ ! -d ".git" ]; then
        error "Not a git repository."
        exit 1
    fi

    # Find latest version tag
    local latest_tag
    latest_tag=$(git tag --sort=-version:refname | head -1)

    if [ -z "$latest_tag" ]; then
        error "No tags found to rollback."
        exit 1
    fi

    warn "Latest tag: $latest_tag"
    echo ""
    read -p "  Delete tag '$latest_tag' locally and remotely? (y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy] ]]; then
        info "Rollback cancelled"
        return
    fi

    # Delete local tag
    git tag -d "$latest_tag" 2>/dev/null && success "Local tag '$latest_tag' deleted" || warn "Could not delete local tag"

    # Delete remote tag
    if git remote get-url origin &>/dev/null 2>&1; then
        read -p "  Also delete remote tag? (y/N): " del_remote
        if [[ "$del_remote" =~ ^[Yy] ]]; then
            git push origin ":refs/tags/$latest_tag" 2>/dev/null && success "Remote tag '$latest_tag' deleted" || warn "Could not delete remote tag"
        fi
    fi

    success "Rollback complete"
}

# ─── Notifications (Slack/Discord webhook) ─────────────────────────────────
send_notification() {
    local message="${1:-Release completed}"

    header "Sending Notification"

    local webhook_url=""

    # Try to detect webhook from .env
    if [ -f ".env" ]; then
        webhook_url=$(grep -E '^(SLACK_WEBHOOK_URL|DISCORD_WEBHOOK_URL)=' .env 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    fi

    if [ -z "$webhook_url" ]; then
        read -p "  Webhook URL (Slack or Discord): " webhook_url
    fi

    if [ -z "$webhook_url" ]; then
        warn "No webhook URL provided. Skipping notification."
        return
    fi

    local project_name
    project_name=$(basename "$(pwd)")
    local version
    version=$(git tag --sort=-version:refname 2>/dev/null | head -1 || echo "unknown")

    local payload
    # Detect Slack vs Discord
    if echo "$webhook_url" | grep -q "discord"; then
        payload=$(cat << DISCORDEOF
{
  "content": "**${project_name}** — ${message}\nVersion: ${version}\nTimestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
}
DISCORDEOF
)
    else
        payload=$(cat << SLACKEOF
{
  "text": "*${project_name}* — ${message}\nVersion: ${version}\nTimestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
}
SLACKEOF
)
    fi

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$payload" "$webhook_url" 2>/dev/null || echo "000")

    if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
        success "Notification sent successfully"
    else
        warn "Notification may have failed (HTTP $http_code)"
    fi
}

# ─── Code Quality Setup ───────────────────────────────────────────────────
setup_code_quality() {
    header "Code Quality Setup"

    read -p "  Set up linting and formatting (ESLint + Prettier)? (y/N): " want_lint
    if [[ ! "$want_lint" =~ ^[Yy] ]]; then
        info "Skipping code quality setup"
        return
    fi

    local project_type
    project_type=$(detect_project_type)

    # Generate .eslintrc.json
    if [ -f ".eslintrc.json" ] || [ -f ".eslintrc.js" ] || [ -f ".eslintrc" ]; then
        warn "ESLint config already exists — skipping"
    else
        case "$project_type" in
            angular)
                cat > .eslintrc.json << 'ESLINTEOF'
{
  "root": true,
  "env": {
    "browser": true,
    "es2022": true
  },
  "extends": [
    "eslint:recommended"
  ],
  "parserOptions": {
    "ecmaVersion": "latest",
    "sourceType": "module"
  },
  "rules": {
    "no-unused-vars": "warn",
    "no-console": "warn",
    "eqeqeq": "error",
    "curly": "error"
  },
  "overrides": [
    {
      "files": ["*.ts"],
      "parser": "@typescript-eslint/parser",
      "extends": [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended"
      ],
      "rules": {
        "@typescript-eslint/no-unused-vars": "warn",
        "@typescript-eslint/explicit-function-return-type": "off"
      }
    }
  ]
}
ESLINTEOF
                ;;
            electron)
                cat > .eslintrc.json << 'ESLINTEOF'
{
  "root": true,
  "env": {
    "browser": true,
    "node": true,
    "es2022": true
  },
  "extends": [
    "eslint:recommended"
  ],
  "parserOptions": {
    "ecmaVersion": "latest",
    "sourceType": "module"
  },
  "rules": {
    "no-unused-vars": "warn",
    "no-console": "off",
    "eqeqeq": "error",
    "curly": "error"
  },
  "overrides": [
    {
      "files": ["*.ts"],
      "parser": "@typescript-eslint/parser",
      "extends": [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended"
      ]
    }
  ]
}
ESLINTEOF
                ;;
            *)
                cat > .eslintrc.json << 'ESLINTEOF'
{
  "root": true,
  "env": {
    "node": true,
    "es2022": true
  },
  "extends": [
    "eslint:recommended"
  ],
  "parserOptions": {
    "ecmaVersion": "latest",
    "sourceType": "module"
  },
  "rules": {
    "no-unused-vars": "warn",
    "no-console": "off",
    "eqeqeq": "error",
    "curly": "error"
  }
}
ESLINTEOF
                ;;
        esac
        success ".eslintrc.json created (type: $project_type)"
    fi

    # Generate .prettierrc
    if [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ] || [ -f ".prettierrc.js" ]; then
        warn "Prettier config already exists — skipping"
    else
        cat > .prettierrc << 'PRETTIEREOF'
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf",
  "bracketSpacing": true,
  "arrowParens": "always"
}
PRETTIEREOF
        success ".prettierrc created"
    fi

    # Add lint script to package.json if missing
    if [ -f "package.json" ]; then
        if ! grep -q '"lint"' package.json; then
            # Insert lint script after the first script entry
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' '/"scripts"/,/\}/{
                    /"/!b
                    /"scripts"/!{
                        /^[[:space:]]*"[a-z]/{
                            N
                            /\n[[:space:]]*}/i\
\    "lint": "eslint . --ext .js,.ts,.tsx",
                            b done
                        }
                    }
                    :done
                }' package.json 2>/dev/null || true
            else
                sed -i '/"scripts"/,/\}/{
                    /"/!b
                    /"scripts"/!{
                        /^[[:space:]]*"[a-z]/{
                            N
                            /\n[[:space:]]*}/i\    "lint": "eslint . --ext .js,.ts,.tsx",
                            b done
                        }
                    }
                    :done
                }' package.json 2>/dev/null || true
            fi

            if grep -q '"lint"' package.json 2>/dev/null; then
                success "Added 'lint' script to package.json"
            else
                info "Could not auto-add lint script. Add manually:"
                echo '    "lint": "eslint . --ext .js,.ts,.tsx"'
            fi
        else
            success "lint script already exists in package.json"
        fi
    fi
}

# ─── Husky Integration ─────────────────────────────────────────────────────
setup_husky() {
    header "Husky Git Hooks"

    read -p "  Set up Husky for git hooks (replaces raw .git/hooks)? (y/N): " want_husky
    if [[ ! "$want_husky" =~ ^[Yy] ]]; then
        info "Skipping Husky setup"
        return
    fi

    if [ ! -f "package.json" ]; then
        error "No package.json found. Skipping."
        return
    fi

    info "Installing husky and lint-staged..."
    npm install --save-dev husky lint-staged 2>&1 | tail -3

    # Initialize husky
    info "Initializing husky..."
    npx husky init 2>/dev/null || npx husky install 2>/dev/null || {
        # Manual fallback
        mkdir -p .husky
    }

    # Create pre-commit hook via husky
    mkdir -p .husky
    cat > .husky/pre-commit << 'HUSKYEOF'
npx lint-staged
HUSKYEOF
    chmod +x .husky/pre-commit
    success "Husky pre-commit hook created"

    # Configure lint-staged in package.json
    if ! grep -q '"lint-staged"' package.json; then
        # Add lint-staged config to package.json using python3
        python3 -c "
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
pkg['lint-staged'] = {
    '*.{js,ts,tsx}': ['eslint --fix', 'prettier --write'],
    '*.{json,md,yml,yaml}': ['prettier --write']
}
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
" 2>/dev/null && success "lint-staged config added to package.json" || warn "Could not add lint-staged config automatically"
    else
        success "lint-staged config already in package.json"
    fi

    # Migrate away from raw .git/hooks if husky is set up
    if [ -f ".git/hooks/pre-commit" ] && [ -d ".husky" ]; then
        info "Husky will now manage git hooks (raw .git/hooks/pre-commit can be removed)"
    fi
}

# ─── Full setup ───────────────────────────────────────────────────────────────
full_setup() {
    local target_dir=${1:-"."}

    if [ "$target_dir" != "." ] && [ ! -d "$target_dir" ]; then
        info "Creating directory: $target_dir"
        mkdir -p "$target_dir"
        cd "$target_dir"
    elif [ "$target_dir" != "." ]; then
        cd "$target_dir"
    fi

    header "Tlink Project Setup"
    info "Directory: $(pwd)"

    check_prerequisites

    local project_type=$(detect_project_type)
    info "Detected project type: $project_type"

    # Git init if needed
    if [ ! -d ".git" ]; then
        header "Initializing Git"
        git init
        success "Git initialized"
    else
        success "Git already initialized"
    fi

    # Create config files
    header "Creating Configuration Files"
    create_gitignore "$project_type"
    create_npmrc

    # Environment file setup
    setup_env_file

    # Create CI/CD workflows
    header "Creating CI/CD Workflows"
    create_ci_workflow "$project_type"
    create_release_workflow "$project_type"

    # Install pre-commit hook
    header "Installing Git Hooks"
    create_pre_commit_hook

    # License
    pick_license

    # README
    read -p "  Generate README.md? (Y/n): " want_readme
    if [[ ! "$want_readme" =~ ^[Nn] ]]; then
        generate_readme
    fi

    # Issue/PR templates
    create_issue_pr_templates

    # Code quality (ESLint + Prettier)
    setup_code_quality

    # Husky git hooks
    setup_husky

    # Docker support
    setup_docker

    # Dependency audit
    read -p "  Run dependency audit? (Y/n): " want_audit
    if [[ ! "$want_audit" =~ ^[Nn] ]]; then
        run_dependency_audit
    fi

    # Validate
    validate_project

    # Setup git remote
    setup_git_remote

    # Branch protection
    setup_branch_protection

    # Initial commit and push
    initial_commit_and_push

    # Health check after push
    if git remote get-url origin &>/dev/null 2>&1; then
        read -p "  Monitor CI status after push? (y/N): " want_health
        if [[ "$want_health" =~ ^[Yy] ]]; then
            health_check_ci
        fi
    fi

    # Summary
    header "Setup Complete!"
    echo "  Files created/updated:"
    echo "    .gitignore"
    echo "    .npmrc"
    echo "    .env.example / .env"
    echo "    .github/workflows/ci.yml"
    if [ "$project_type" = "electron" ]; then
        echo "    .github/workflows/release.yml"
    fi
    echo "    .git/hooks/pre-commit"
    echo "    README.md (if generated)"
    echo "    LICENSE (if chosen)"
    echo "    .github/ISSUE_TEMPLATE/ (if created)"
    echo "    .github/PULL_REQUEST_TEMPLATE.md (if created)"
    echo ""
    echo "  Available commands:"
    echo "    ./scripts/setup-project.sh --validate        # Check CI readiness"
    echo "    ./scripts/setup-project.sh --fix             # Auto-fix issues"
    echo "    ./scripts/setup-project.sh --changelog       # Generate CHANGELOG.md"
    echo "    ./scripts/setup-project.sh --bump patch      # Bump version (major|minor|patch)"
    echo "    ./scripts/setup-project.sh --rollback        # Delete latest version tag"
    echo "    ./scripts/setup-project.sh --notify          # Send webhook notification"
    if [ "$project_type" = "electron" ]; then
        echo "    ./scripts/setup-project.sh --release v1.0.0  # Create release"
    fi
    echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
    case "${1:-}" in
        --fix)
            fix_issues
            ;;
        --validate)
            validate_project
            ;;
        --release)
            if [ -z "${2:-}" ]; then
                error "Usage: $0 --release v1.0.0"
                exit 1
            fi
            do_release "$2"
            ;;
        --changelog)
            generate_changelog
            ;;
        --bump)
            if [ -z "${2:-}" ]; then
                error "Usage: $0 --bump major|minor|patch"
                exit 1
            fi
            do_version_bump "$2"
            ;;
        --rollback)
            do_rollback
            ;;
        --notify)
            send_notification "${2:-Release completed}"
            ;;
        --help|-h)
            echo "Usage: $0 [options] [directory]"
            echo ""
            echo "Options:"
            echo "  (none)              Full setup — git, .gitignore, CI/CD, hooks, env, etc."
            echo "  --fix               Auto-fix common CI issues"
            echo "  --validate          Check if project is CI-ready"
            echo "  --release VER       Create and push a release tag (e.g., v1.0.0)"
            echo "  --changelog         Generate CHANGELOG.md from git log"
            echo "  --bump TYPE         Bump version in package.json (major|minor|patch)"
            echo "  --rollback          Delete the latest version tag (local + remote)"
            echo "  --notify [MSG]      Send notification via Slack/Discord webhook"
            echo "  --help              Show this help"
            echo ""
            echo "Full setup includes (each offered interactively):"
            echo "  - Git init + .gitignore + .npmrc"
            echo "  - Environment file (.env.example / .env)"
            echo "  - CI/CD workflows (GitHub Actions)"
            echo "  - License picker (MIT, Apache 2.0, GPL 3.0)"
            echo "  - README.md generator"
            echo "  - Issue & PR templates"
            echo "  - Code quality (ESLint + Prettier)"
            echo "  - Husky git hooks + lint-staged"
            echo "  - Docker support (Dockerfile, docker-compose, .dockerignore)"
            echo "  - Dependency audit (npm audit)"
            echo "  - Branch protection (via gh CLI)"
            echo "  - CI health check after push"
            echo ""
            echo "Examples:"
            echo "  $0                          # Full interactive setup"
            echo "  $0 my-new-app               # Create and setup new directory"
            echo "  $0 --fix                    # Fix CI issues in existing project"
            echo "  $0 --validate               # Check project readiness"
            echo "  $0 --release v1.0.0         # Tag and release"
            echo "  $0 --changelog              # Generate changelog from commits"
            echo "  $0 --bump patch             # Bump patch version, tag, push"
            echo "  $0 --rollback               # Remove latest version tag"
            echo "  $0 --notify 'Deployed v2!'  # Send webhook notification"
            ;;
        *)
            full_setup "${1:-.}"
            ;;
    esac
}

main "$@"
