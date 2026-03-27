#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Tlink NetOps — License Key Generator
# Usage:
#   ./generate-license.sh --tier pro --expiry 2027-12-31 --customer "Acme Corp"
#   ./generate-license.sh --list
#   ./generate-license.sh --revoke TLINK-P8K2-2712-R4M9-X7C3
#
# NOTE: For key generation, this script delegates to the Node.js version
#       to guarantee identical FNV hash output. The Node.js version is the
#       canonical implementation.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/.license-log.csv"
NODE_SCRIPT="$SCRIPT_DIR/generate-license.js"

# ── Helpers ──────────────────────────────────────────────────────────────────

die ()  { echo "ERROR: $*" >&2; exit 1; }
info () { echo "  $*"; }

ensure_log () {
    if [[ ! -f "$LOG_FILE" ]]; then
        echo "key,tier,expiry,customer,created,status" > "$LOG_FILE"
    fi
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_list () {
    ensure_log
    if [[ $(wc -l < "$LOG_FILE") -le 1 ]]; then
        echo "No license keys generated yet."
        exit 0
    fi
    echo ""
    echo "  Tlink NetOps — License Keys"
    echo "  ─────────────────────────────────────────────────────────────────"
    printf "  %-30s %-12s %-12s %-20s %s\n" "KEY" "TIER" "EXPIRY" "CUSTOMER" "STATUS"
    echo "  ─────────────────────────────────────────────────────────────────"
    tail -n +2 "$LOG_FILE" | while IFS=',' read -r key tier expiry customer created status; do
        printf "  %-30s %-12s %-12s %-20s %s\n" "$key" "$tier" "$expiry" "$customer" "$status"
    done
    echo ""
}

cmd_revoke () {
    local target_key="$1"
    ensure_log
    if ! grep -q "^${target_key}," "$LOG_FILE"; then
        die "Key not found in log: $target_key"
    fi
    # Use sed to replace status for that key
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/^${target_key},\(.*\),active$/$(echo "$target_key"),\1,revoked/" "$LOG_FILE"
    else
        sed -i "s/^${target_key},\(.*\),active$/$(echo "$target_key"),\1,revoked/" "$LOG_FILE"
    fi
    echo "Key revoked: $target_key"
}

cmd_generate () {
    local tier="$1" expiry="$2" customer="$3"

    # Validate tier
    case "$tier" in
        pro|enterprise) ;;
        *) die "Invalid tier: $tier (must be 'pro' or 'enterprise')" ;;
    esac

    # Validate expiry
    if ! [[ "$expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        die "Invalid expiry format: $expiry (expected YYYY-MM-DD)"
    fi

    # Delegate to Node.js for deterministic key generation
    if ! command -v node &>/dev/null; then
        die "Node.js is required for key generation. Please install Node.js."
    fi

    node "$NODE_SCRIPT" --tier "$tier" --expiry "$expiry" --customer "$customer"
}

# ── Argument parsing ─────────────────────────────────────────────────────────

TIER=""
EXPIRY=""
CUSTOMER=""
DO_LIST=false
REVOKE_KEY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tier)     TIER="$2"; shift 2 ;;
        --expiry)   EXPIRY="$2"; shift 2 ;;
        --customer) CUSTOMER="$2"; shift 2 ;;
        --list)     DO_LIST=true; shift ;;
        --revoke)   REVOKE_KEY="$2"; shift 2 ;;
        -h|--help)
            echo "Usage:"
            echo "  $(basename "$0") --tier pro|enterprise --expiry YYYY-MM-DD --customer \"Name\""
            echo "  $(basename "$0") --list"
            echo "  $(basename "$0") --revoke TLINK-XXXX-XXXX-XXXX-XXXX"
            exit 0
            ;;
        *)          die "Unknown argument: $1" ;;
    esac
done

if $DO_LIST; then
    cmd_list
    exit 0
fi

if [[ -n "$REVOKE_KEY" ]]; then
    cmd_revoke "$REVOKE_KEY"
    exit 0
fi

if [[ -z "$TIER" || -z "$EXPIRY" || -z "$CUSTOMER" ]]; then
    die "Required: --tier, --expiry, --customer (use --help for usage)"
fi

cmd_generate "$TIER" "$EXPIRY" "$CUSTOMER"
