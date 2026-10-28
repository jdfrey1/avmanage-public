#!/usr/bin/env bash
# Checks a source tree for anything that must not be published: private strings from
# instance/denylist.txt and common secret formats. Exits non-zero if anything is found.
#
#   scripts/check-public.sh [DIR]     (default: the files git tracks, minus instance/)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DENYLIST="$REPO_ROOT/instance/denylist.txt"
DIR="${1:-}"

if [[ ! -f "$DENYLIST" ]]; then
  echo "check-public: $DENYLIST not found — create it (one private string per line)." >&2
  exit 2
fi

patterns="$(mktemp)"; trap 'rm -f "$patterns"' EXIT
grep -v '^\s*#' "$DENYLIST" | sed '/^\s*$/d' > "$patterns"

# Secret-looking strings (API keys, private keys, tokens).
SECRETS='sk-ant-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,}'

status=0
if [[ -n "$DIR" ]]; then
  cd "$DIR"
  files() { find . -type f -not -path './.git/*' -print0; }
else
  cd "$REPO_ROOT"
  files() { git ls-files -z -- . ':!instance/'; }
fi

if hits="$(files | xargs -0 grep -nIiF -f "$patterns" -- 2>/dev/null)"; then
  echo "check-public: private strings found:" >&2
  echo "$hits" >&2
  status=1
fi
if hits="$(files | xargs -0 grep -nIE "$SECRETS" -- 2>/dev/null)"; then
  echo "check-public: possible secrets found:" >&2
  echo "$hits" >&2
  status=1
fi
if command -v gitleaks >/dev/null 2>&1 && [[ -n "$DIR" ]]; then
  gitleaks detect --no-git --source . --redact || status=1
fi

[[ $status -eq 0 ]] && echo "check-public: clean"
exit $status
