---
name: release-beta
description: Cut the next vexdock beta release - version bump, release PR, tag, publish.
argument-hint: "Optional explicit version, e.g. v0.2.0-beta.1"
disable-model-invocation: true
---

Cut the next beta. Tags are `vX.Y.Z-beta.N`; the Release workflow refuses to run
unless all three `package.json` files say the same `X.Y.Z-beta.N` as the tag.

## 1. Preflight

```sh
git switch main && git pull --ff-only
git status --short          # must be empty
make check
```

Stop and report if `make check` fails or the tree is dirty. Never release from a
dirty tree.

## 2. Version

Use the argument if given, otherwise bump the beta counter:

```sh
jq -r .version package.json                       # e.g. 0.1.0-beta.41
git tag --list 'v*' | sort -V | tail -1           # highest existing tag
```

Next is that version with `beta.N+1`. Confirm the number with the user in one
line before touching files.

## 3. Release branch and bump

```sh
git switch -c release/vX.Y.Z-beta.N
```

Edit the `version` field in `package.json`, `apps/web/package.json` and
`apps/auth/package.json` to `X.Y.Z-beta.N` (no leading `v`). Nothing else
changes in this commit.

```sh
git commit -am "chore(release): prepare vX.Y.Z-beta.N"
git push -u origin release/vX.Y.Z-beta.N
gh pr create --fill --title "chore(release): prepare vX.Y.Z-beta.N"
```

PR body: one line per user-visible change since the last tag, from
`git log vPREV..HEAD --oneline`.

## 4. Merge, then tag

Wait for CI, then merge with a merge commit (every past release tag points at
one):

```sh
gh pr checks --watch
gh pr merge --merge --delete-branch
git switch main && git pull --ff-only
```

Ask the user before this next step - pushing the tag publishes images to GHCR
and creates a public GitHub prerelease:

```sh
git tag vX.Y.Z-beta.N && git push origin vX.Y.Z-beta.N
gh run watch
```

The workflow builds the three `linux/amd64` images, creates the prerelease and
attaches `installer/install.sh` and `compose.yml`. A `-` in the tag means no
`:latest` retag and `--prerelease` on the release - that is what makes it a beta.

## If the tag was wrong

Delete both remote and local tag, fix, re-tag. Images already pushed to GHCR
stay; only re-tag after the workflow failed early, otherwise bump to the next
beta instead.
