#!/usr/bin/env bash
# Cut the next beta the way every release so far was cut: bump the three
# package.json files on a release branch, merge that through a pull request once
# CI is green, then tag the merge commit, which is what starts the Release
# workflow.
#
#   ./scripts/release-beta.sh                 # 0.1.0-beta.75 -> 0.1.0-beta.76, end to end
#   ./scripts/release-beta.sh --dry-run       # print what it would do, change nothing
#   ./scripts/release-beta.sh --version X     # release X instead of the next beta
#   ./scripts/release-beta.sh --tag           # only tag: the release PR is already merged
#
# With an authenticated `gh` the whole run is one command: it opens the pull
# request, waits for its checks, merges it and tags. Without one it stops after
# pushing the branch and says what to do; `--tag` finishes the job after merge.
set -euo pipefail

FILES=(package.json apps/web/package.json apps/auth/package.json)
BASE=main

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
say() { printf '==> %s\n' "$*"; }
die() { printf 'release-beta: %s\n' "$*" >&2; exit 1; }

dry_run=false
tag_only=false
version=''
branch=''
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) dry_run=true ;;
	--tag) tag_only=true ;;
	--version) version="${2:?--version needs a value}"; shift ;;
	--branch) branch="${2:?--branch needs a value}"; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "unknown argument: $1 (see --help)" ;;
	esac
	shift
done

# Mutating steps go through here, so --dry-run prints them instead.
run() {
	if $dry_run; then
		printf '  + %s\n' "$*"
	else
		"$@"
	fi
}

cd "$(git rev-parse --show-toplevel)"

# The "version" line of one package.json, read from a file or from `git show`.
version_in() { sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)",\{0,1\}[[:space:]]*$/\1/p' | head -n 1; }

# 0.1.0-beta.75 -> 0.1.0-beta.76; a stable 0.1.0 -> 0.1.1-beta.1.
next_beta() {
	local current="$1"
	if [[ "$current" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-beta\.([0-9]+)$ ]]; then
		printf '%s-beta.%d\n' "${BASH_REMATCH[1]}" $((BASH_REMATCH[2] + 1))
	elif [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
		printf '%s.%s.%d-beta.1\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" $((BASH_REMATCH[3] + 1))
	else
		die "cannot work out the beta after '$current'; pass --version"
	fi
}

# The Release workflow only accepts vX.Y.Z or vX.Y.Z-suffix tags.
valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; }

remote_tag_exists() { git ls-remote --exit-code --tags origin "refs/tags/v$1" >/dev/null 2>&1; }

actions_url() {
	local url repo owner
	# owner/repo are the last two segments of any remote spelling: https, ssh or git@host:owner/repo.
	url="$(git remote get-url origin)"
	url="${url%.git}"
	url="${url//://}"
	repo="${url##*/}"
	url="${url%/*}"
	owner="${url##*/}"
	printf 'https://github.com/%s/%s/actions/workflows/release.yml\n' "$owner" "$repo"
}

have_gh() { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }

# Tags the tip of origin/main, after checking it really is the release commit.
tag_release() {
	local want="$1" commit found
	run git fetch --quiet origin "$BASE"
	commit="$(git rev-parse "origin/$BASE")"
	for file in "${FILES[@]}"; do
		found="$(git show "origin/$BASE:$file" | version_in)"
		[ "$found" = "$want" ] || $dry_run || die "origin/$BASE:$file is $found, not $want; is the release PR merged?"
	done
	remote_tag_exists "$want" && die "v$want is already on origin"
	if git rev-parse -q --verify "refs/tags/v$want" >/dev/null; then
		# Left behind by a run whose push failed: reuse it only if it is the same commit.
		[ "$(git rev-parse "v$want^{commit}")" = "$commit" ] || die "a local v$want points elsewhere; delete it first"
	else
		run git tag -a "v$want" -m "v$want" "$commit"
	fi
	say "tagging $(git rev-parse --short "$commit") as v$want"
	run git push origin "refs/tags/v$want"
	say "v$want is out; the Release workflow publishes it: $(actions_url)"
}

if $tag_only; then
	git fetch --quiet origin "$BASE"
	if [ -z "$version" ]; then
		version="$(git show "origin/$BASE:package.json" | version_in)"
	fi
	valid_version "$version" || die "'$version' is not a version the Release workflow accepts"
	tag_release "$version"
	exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
	die 'the working tree has changes; commit or stash them first'
fi
say "fetching origin/$BASE"
git fetch --quiet origin "$BASE"

current="$(git show "origin/$BASE:package.json" | version_in)"
for file in "${FILES[@]}"; do
	found="$(git show "origin/$BASE:$file" | version_in)"
	[ "$found" = "$current" ] || die "$file is $found but package.json is $current; line them up first"
done
[ -n "$version" ] || version="$(next_beta "$current")"
valid_version "$version" || die "'$version' is not a version the Release workflow accepts"
[ "$version" != "$current" ] || die "origin/$BASE is already $version; to tag it, run with --tag"
remote_tag_exists "$version" && die "v$version is already on origin"
[ -n "$branch" ] || branch="release/v$version"
git rev-parse -q --verify "refs/heads/$branch" >/dev/null && die "a local branch $branch already exists"

say "releasing v$version (origin/$BASE is $current) from $branch"
run git switch --quiet -c "$branch" "origin/$BASE"
for file in "${FILES[@]}"; do
	run sed -i.bak "s/\"version\": \"$current\"/\"version\": \"$version\"/" "$file"
	run rm -f "$file.bak"
	if ! $dry_run; then
		[ "$(version_in <"$file")" = "$version" ] || die "could not bump $file"
	fi
done
run git commit --quiet -m "chore(release): prepare v$version" -- "${FILES[@]}"
run git push --quiet -u origin "$branch"

if ! have_gh; then
	say "no authenticated gh: open a pull request from $branch into $BASE, merge it once CI is green,"
	say "then finish with: ./scripts/release-beta.sh --tag"
	exit 0
fi

title="chore(release): prepare v$version"
run gh pr create --base "$BASE" --head "$branch" --title "$title" \
	--body "Bumps the three package.json files to \`$version\`. Merging it lets \`scripts/release-beta.sh\` tag v$version."

say 'waiting for CI on the release pull request'
if ! $dry_run; then
	# A check suite takes a few seconds to register after the push; until it does, gh reports no checks.
	for _ in $(seq 1 30); do
		checks="$(gh pr checks "$branch" 2>&1 || true)"
		[[ "$checks" == *'no checks reported'* ]] || break
		sleep 5
	done
	gh pr checks "$branch" --watch --fail-fast || die "CI failed on $branch; fix it, merge, then run with --tag"
fi

run gh pr merge "$branch" --merge --delete-branch --body "v$version"
tag_release "$version"
