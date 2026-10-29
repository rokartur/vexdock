---
name: release-beta
description: Cut the next vexdock beta release - version bump, release PR, tag, publish.
argument-hint: "Optional explicit version, e.g. 0.2.0-beta.1"
disable-model-invocation: true
---

Cut the next beta with `make release-beta` (`scripts/release-beta.sh`; `--help`
lists its steps). Never do by hand a step the script does.

1. Preflight: `git switch main && git pull --ff-only`, then `make check`. Stop
   and report on a dirty tree or a failing check.
2. Preview: `./scripts/release-beta.sh --dry-run` prints the version and every
   step. An explicit version goes in as `--version 0.2.0-beta.1`, without the
   leading `v`.
3. Ask the user once, naming the version: the run opens a pull request, and the
   tag publishes images to GHCR and a public GitHub prerelease.
4. Release: `make release-beta`, or `./scripts/release-beta.sh --version X`.
   When it stops early, do the next step it prints.
5. Watch the Release workflow the tag starts. Its run lists the tag as its
   branch and shows up a few seconds after the push, so repeat until this
   prints an id, then `gh run watch <id> --exit-status`:

   ```sh
   gh run list --workflow release.yml --branch vX.Y.Z-beta.N --json databaseId --jq '.[0].databaseId'
   ```

## If the tag was wrong

Re-tag only when the Release workflow failed before any image was pushed; it
creates the prerelease last, so none exists yet. Otherwise cut the next beta. To
re-tag, delete the tag, merge the fix to `main`, then run
`./scripts/release-beta.sh --tag`:

```sh
git push origin :refs/tags/vX.Y.Z-beta.N && git tag -d vX.Y.Z-beta.N
```
