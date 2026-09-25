# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary. Until it exists, the "Words" section of `docs/codebase.md` is the glossary.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

Neither exists yet, so work from what does. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them when a term or decision actually gets settled.

Vexdock is a single context: one `CONTEXT.md` and one `docs/adr/` at the root, ADRs named `0001-short-title.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the glossary's term, not a synonym it avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (short title), but worth reopening because…_
