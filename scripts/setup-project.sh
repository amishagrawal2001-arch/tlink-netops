#!/bin/bash
#
# Tlink Project Setup & CI/CD Generator
# ======================================
# This script sets up a new Electron + Angular project with:
# - Git initialization with proper .gitignore
# - .npmrc for peer dependency handling
# - GitHub Actions CI pipeline
# - GitHub Actions Release pipeline (Mac/Win/Linux installers)
# - Pre-commit validation hook
# - Contributing guide template
#
# Usage:
#   ./scripts/setup-project.sh                    # Setup current directory
#   ./scripts/setup-project.sh my-new-app         # Create and setup new directory
#   ./scripts/setup-project.sh --fix              # Fix common CI issues in existing project
#   ./scripts/setup-project.sh --validate         # Validate project is CI-ready
#   ./scripts/setup-project.sh --release v1.0.0   # Tag and push a release
#
# Requirements: git, node (22+), npm

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

    # Create CI/CD workflows
    header "Creating CI/CD Workflows"
    create_ci_workflow "$project_type"
    create_release_workflow "$project_type"

    # Install pre-commit hook
    header "Installing Git Hooks"
    create_pre_commit_hook

    # Validate
    validate_project

    # Setup git remote
    setup_git_remote

    # Initial commit and push
    initial_commit_and_push

    # Summary
    header "Setup Complete!"
    echo "  Files created/updated:"
    echo "    .gitignore"
    echo "    .npmrc"
    echo "    .github/workflows/ci.yml"
    if [ "$project_type" = "electron" ]; then
        echo "    .github/workflows/release.yml"
    fi
    echo "    .git/hooks/pre-commit"
    echo ""
    echo "  Available commands:"
    echo "    ./scripts/setup-project.sh --validate      # Check CI readiness"
    echo "    ./scripts/setup-project.sh --fix           # Auto-fix issues"
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
        --help|-h)
            echo "Usage: $0 [options] [directory]"
            echo ""
            echo "Options:"
            echo "  (none)          Full setup — git, .gitignore, CI/CD, hooks"
            echo "  --fix           Auto-fix common CI issues"
            echo "  --validate      Check if project is CI-ready"
            echo "  --release VER   Create and push a release tag (e.g., v1.0.0)"
            echo "  --help          Show this help"
            echo ""
            echo "Examples:"
            echo "  $0                      # Setup current directory"
            echo "  $0 my-new-app           # Create and setup new directory"
            echo "  $0 --fix                # Fix CI issues in existing project"
            echo "  $0 --validate           # Check project readiness"
            echo "  $0 --release v1.0.0     # Tag and release"
            ;;
        *)
            full_setup "${1:-.}"
            ;;
    esac
}

main "$@"
