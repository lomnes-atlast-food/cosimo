#!/usr/bin/env bash
# Computes the next release version for the `prepare` job of .github/workflows/release.yml, from
# the highest `v*` git tag and the labels of the PRs merged since it:
#
#   release:major > release:minor > patch (the default). Nothing is published when every commit
#   belongs to a release:skip PR (an unlabeled PR, or a commit pushed without a PR, counts as a
#   patch), or when the diff touches only *.md, docs/**, .claude/**, or .github/ISSUE_TEMPLATE/**.
#   No prior tag means the first release, v0.3.0, with no bump computed. A HEAD already tagged
#   publishes nothing (idempotent re-runs).
#
# Prints `key=value` lines (version, tag, sha, publish, prerelease) to stdout; the workflow
# appends them to $GITHUB_OUTPUT. Extracted out of the workflow so the bump/skip logic is testable
# locally, without a real git history or `gh` credentials:
#
#   FAKE_TAGS="v1.0.0
#   v1.1.0" FAKE_HEAD=abc123 FAKE_COMMITS="c1
#   c2" FAKE_LABELS_c1="release:minor" FAKE_CHANGED_FILES="apps/server/src/x.ts" \
#     bash scripts/next-version.sh --dry-run
#
# Real mode needs `git` (full history and tags: `actions/checkout` with `fetch-depth: 0`) and an
# authenticated `gh` (for PR labels; GITHUB_REPOSITORY is set by GitHub Actions).
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

DOCS_ONLY_RE='^(.*\.md|docs/.*|\.claude/.*|\.github/ISSUE_TEMPLATE/.*)$'

latest_tag() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "${FAKE_TAGS:-}" | grep -v '^$' | sort -V | tail -1 || true
  else
    git tag -l 'v*' --sort=-v:refname | head -1
  fi
}

head_sha() {
  if [ "$DRY_RUN" = 1 ]; then echo "${FAKE_HEAD:-headsha}"; else git rev-parse HEAD; fi
}

head_is_tagged() {
  if [ "$DRY_RUN" = 1 ]; then
    [ "${FAKE_HEAD_TAGGED:-0}" = 1 ]
  else
    [ -n "$(git tag --points-at "$1" | grep '^v' || true)" ]
  fi
}

commits_since() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "${FAKE_COMMITS:-}" | grep -v '^$' || true
  else
    git log "${1}..HEAD" --format=%H
  fi
}

changed_files_since() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "${FAKE_CHANGED_FILES:-}" | grep -v '^$' || true
  else
    git diff --name-only "${1}..HEAD"
  fi
}

# Labels of the PR(s) containing commit $1, one per line. In dry-run mode, read from the fixture
# variable FAKE_LABELS_<sha> (comma-separated; set by the caller for each sha in FAKE_COMMITS).
pr_labels_for_commit() {
  sha="$1"
  if [ "$DRY_RUN" = 1 ]; then
    eval "labels=\"\${FAKE_LABELS_${sha}:-}\""
    printf '%s\n' "$labels" | tr ',' '\n' | grep -v '^$' || true
  else
    gh api "repos/${GITHUB_REPOSITORY:?}/commits/${sha}/pulls" --jq '.[].labels[].name' 2>/dev/null || true
  fi
}

bump_version() {
  prev="$1"
  kind="$2"
  core="${prev#v}"
  core="${core%%-*}"
  maj="${core%%.*}"
  rest="${core#*.}"
  min="${rest%%.*}"
  patch="${rest#*.}"
  case "$kind" in
    major) maj=$((maj + 1)); min=0; patch=0 ;;
    minor) min=$((min + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
  esac
  echo "${maj}.${min}.${patch}"
}

emit() {
  echo "version=$1"
  echo "tag=$2"
  echo "sha=$3"
  echo "publish=$4"
  echo "prerelease=$5"
}

main() {
  prev=$(latest_tag)
  head=$(head_sha)

  if [ -z "$prev" ]; then
    emit "0.3.0" "v0.3.0" "$head" "true" "false"
    return
  fi

  if head_is_tagged "$head"; then
    emit "" "" "$head" "false" "false"
    return
  fi

  bump="patch"
  any_pr=0
  all_skip=1
  while IFS= read -r sha; do
    if [ -z "$sha" ]; then continue; fi
    labels=$(pr_labels_for_commit "$sha")
    if [ -z "$labels" ]; then all_skip=0; continue; fi
    any_pr=1
    while IFS= read -r label; do
      if [ -z "$label" ]; then continue; fi
      if [ "$label" != "release:skip" ]; then all_skip=0; fi
      if [ "$label" = "release:major" ]; then bump="major"; fi
      if [ "$label" = "release:minor" ] && [ "$bump" != "major" ]; then bump="minor"; fi
    done <<< "$labels"
  done <<< "$(commits_since "$prev")"

  docs_only=1
  files=$(changed_files_since "$prev")
  if [ -z "$files" ]; then docs_only=0; fi
  while IFS= read -r f; do
    if [ -z "$f" ]; then continue; fi
    if ! printf '%s\n' "$f" | grep -Eq "$DOCS_ONLY_RE"; then docs_only=0; fi
  done <<< "$files"

  skip=0
  if [ "$any_pr" = 1 ] && [ "$all_skip" = 1 ]; then skip=1; fi
  if [ "$docs_only" = 1 ]; then skip=1; fi
  if [ "$skip" = 1 ]; then
    emit "" "" "$head" "false" "false"
    return
  fi

  next=$(bump_version "$prev" "$bump")
  emit "$next" "v$next" "$head" "true" "false"
}

main
