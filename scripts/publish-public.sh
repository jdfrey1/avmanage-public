#!/usr/bin/env bash
# Publishes the committed state of this (private) repo to the public repo as one new commit.
#
#   scripts/publish-public.sh PUBLIC_REPO_DIR ["release message"]
#
# PUBLIC_REPO_DIR is a local clone of the public repository. The files are taken from HEAD
# with `git archive` (so instance/ and anything uncommitted are left out), checked with
# scripts/check-public.sh, copied over the public clone and committed there. Nothing is pushed —
# review the commit, then `git push` in the public clone.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="${1:?usage: publish-public.sh PUBLIC_REPO_DIR [message]}"
PUBLIC="$(cd "$PUBLIC" && pwd)"
cd "$REPO_ROOT"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "publish: commit or stash your changes first — only committed work is published." >&2
  exit 1
fi
if [[ ! -d "$PUBLIC/.git" ]]; then
  echo "publish: $PUBLIC is not a git clone." >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
MSG="${2:-Release $(date +%Y-%m-%d) ($SHA)}"
EXPORT="$(mktemp -d)"; trap 'rm -rf "$EXPORT"' EXIT

git archive HEAD | tar -x -C "$EXPORT"
"$REPO_ROOT/scripts/check-public.sh" "$EXPORT"

# Mirror the export into the public clone (its .git stays untouched).
rsync -a --delete --exclude '.git/' "$EXPORT/" "$PUBLIC/"

cd "$PUBLIC"
git add -A
if git diff --cached --quiet; then
  echo "publish: nothing changed since the last release."
  exit 0
fi
git commit -q -m "$MSG"
echo "publish: committed \"$MSG\" in $PUBLIC — review it, then git push."
