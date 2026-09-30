## Always
- This is open source self-hosted alternative to Vercel, Heroku, and Netlify
- Web and manager change together frequently; expect coordinated PRs

## When touching apps/web
- Coordinate updates with manager/internal backend changes

## When touching manager/internal
- Coordinate updates with apps/web frontend changes

## Team (from git)
- Releases are versioned as v0.1.0-beta.N with automated chore(release) commits
- Merge pull requests from feature branches into main; CI deletes the branch after merge
- Code lives in: apps/web (frontend), manager/internal (backend), apps/auth, scripts/migrate-dokploy.ts
- Web and manager change together frequently; expect coordinated PRs
- Commits use conventional format: type(scope): description
- Feature work includes docs updates (docs/api.md, docs/codebase.md, AGENTS.md)

<!-- git-head: 148c20f -->
