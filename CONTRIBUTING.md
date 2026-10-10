# Contributing

## Getting set up

```sh
git clone https://github.com/rokartur/vexdock
cd vexdock
bun install
make check
```

`make check` runs gofmt, `go vet`, the Go tests, and the typecheck and tests of
both the dashboard and the auth service. CI runs that plus `shellcheck` over the
shell scripts and an integration job that installs and deploys against real
Docker, so a green `make check` is necessary but not sufficient when you touch
either.

## Running the whole thing locally

```sh
make dev-up             # builds the three images, starts the stack
./scripts/smoke-test.sh # end-to-end: setup, deploy, domain, proxy
make dev-logs
make dev-down
```

State goes to `./.vexdock`, never `/opt`.

Nginx serves `apps/web/dist/client` straight from the working tree, so a
dashboard change only needs `make web` to show up on :3000.

For instant feedback run the dev server instead. It keeps using the stack for
`/api`, so auth, the manager and the terminal behave exactly as they do on
:3000:

```sh
make dev-up    # the stack has to be running
make web-dev   # dashboard on :5173 with HMR
```

## Layout

[docs/codebase.md](docs/codebase.md) is the map: every package and what it
owns, the dashboard's files, the words the code uses, and one request traced
from a button to the database and back. Read it before your first change.

## Conventions

**Go.** Standard library first. No framework, no ORM. Errors are wrapped with
context and returned, not logged and swallowed. Anything that reaches a command
line is validated in `internal/security` before it gets there, and arguments are
always separate slice elements.

**TypeScript.** Strict mode, no `any`, inferred types wherever possible. Server
state belongs to TanStack Query; component state is local.

**English.** American spelling everywhere: code, comments, docs, UI copy. `color`,
`behavior`, `canceled`, `catalog`, not the British forms. The exception is a value
already on the wire: the deployment status `cancelled` and the `deployment.cancelled`
event keep their spelling because renaming them breaks stored rows and clients.

**UI.** Arc UI components (uiarc.dev) in `src/components/arc`, added with
`bunx shadcn add @uiarc/<name>` and converted on arrival: the component moves
from `arc/<name>/<name>.tsx` to a flat `arc/<name>.tsx`, the registry's
`.module.css` becomes Tailwind classes on the elements and is deleted, its
Radix primitives become `@base-ui/react` ones (`render` instead of `asChild`,
`data-open`/`data-starting-style` instead of `data-state`), unused
props are trimmed, and sizes, radii and timings come from the tokens below, not
Arc's defaults. Every Arc item pulls `arc-motion-tokens`, so decline the CLI's
offer to overwrite `arc/motion-tokens.ts`; it holds this dashboard's speeds.
Pages go through the vocabulary first:
`src/components/primitives.tsx` maps them to the vocabulary the dashboard uses
(Page, Tabs, Section, FormSection, Cell, Field, Input, Select, Switch, Button,
IconButton, Status, Confirm, EmptyState), so a design change happens in one
file. The shell is a sidebar that is the same on every page, carrying every
destination and the project tree, and a header over the page; tables are `DataTable` in
`components/data-table.tsx`, its own primitive that pages import directly. A
page reaches for an `arc/*` component only for what the vocabulary has no word
for (a dialog, a dropdown menu, an alert).
The visual language is Arc's dark theme (`foundation.css`, the only palette there is): a graphite
canvas, cards a shade lighter with a hairline border and a resting shadow, the
foreground color for the one primary action, sentence case everywhere, a neutral gray ramp.
The panel is monochrome throughout, charts included. Dense tables, and no continuously repainting animation: the panel
is often left open.

Every page is a `Page`: the breadcrumb and that page's actions go into the
shell's header through `PageChrome`, its sub-navigation and its filters
into a row the page draws under it, content below. `Page` also names the browser tab
from the URL; a route whose last segment is an id passes `name` for it.
`Tabs` are Arc's tabs and move through the URL; `Segmented` is Arc's segmented control,
and moves a value. Every action
carries a Tabler icon: a row action is an `IconButton` with its name in the
tooltip, a destructive one is wrapped in `Confirm`. One reading is a `Cell`,
never a hand-built box. A settings page is a stack of `FormSection` cards:
title and description, controls, then a footer strip with a hint on the left
and that card's own Save on the right. `SaveButton` is handed the card's
mutation so it can answer for two seconds after the write lands, `aside` is the
read-only facts column next to the controls, and a card that also adds to a
list puts the table in its body and the add form in a `FormDialog` opened from
its actions, never under the table. Likewise a record opened from a list (a
deployment's pipeline, a container's log) is a `DetailDialog`, never a row
unfolded under the one clicked: `DataTable`'s `detail` does that for you.

The look is carried by tokens, not by classes on pages: Arc's
`src/components/arc/foundation.css` owns the palette, radii, control heights
and motion, and `src/styles.css` maps the names Tailwind and the pages use onto
them, with the type scale and `--font-sans` (Inter; `--font-mono` is the system
stack, for machine output: console, code, ids). Reskinning is a token edit and
never a sweep over pages. Arc components are Tailwind classes only, no CSS
modules; `foundation.css` is the one stylesheet they share, and it holds the
dashboard's pre-Arc sizes, radii and durations rather than Arc's own.
`@/utils/cn` is the `createCn` with the custom `--text-*` scale registered. Every corner
in the app comes off `--radius`: the whole `--radius-*` ladder is derived from
it, `md`/`lg` for anything clickable and `xl` upwards for boxes, so no
component ever writes a radius of its own; a box that is a panel uses Arc's
`--radius-panel`. A card draws its edge as a one-pixel border plus the `raised`
utility, Arc's `--shadow-resting`.
Hairlines come in two weights, and using the wrong one flattens the page:
`--border` is a container's own edge, `--rule` is a separator inside one and is
quieter. Tables separate rows with `--rule`, readings sit in a
`Cells` grid that owns the hairlines its children must not redraw, and
attributes are read as a `Facts` list: label left, value right, a rule between
rows. The type scale is custom `text-*` tokens; `utils/cn.ts` registers them
with tailwind-merge so they never clobber a text color.

Motion is a token too. Arc's `motionTokens` (`arc/motion-tokens.ts`) and its
`--ease-*`/`--duration-*` tokens time every popover, menu, select, dialog and
tooltip, at the dashboard's pre-Arc speeds (125 to 300ms), without a page
naming it. Reduced motion drops travel and scaling and keeps the fades. Page
blocks enter staggered (`enter-children` on `Page`), a selection slides
(`ActivePill`) and a live reading counts (`AnimatedNumber`). Everything uses
`motion.*` from `motion/react`; there is no `LazyMotion` split, since Arc's
components need the full feature set on first paint anyway.

## Tests

Focused tests for logic that can break silently: the Nginx generator, the
compose parser, validation, encryption, path confinement, delivery signatures and
the deployment's terminal states. `scripts/smoke-test.sh` covers the real path
through a running stack. Please do not add tests that only restate the
implementation.

## Pull requests

- One concern per pull request.
- `make check` passes.
- If behavior changed, the docs changed with it.
- Merging deletes the branch: `.github/workflows/delete-merged-branch.yml` does
  it for every merged pull request from this repository, so a follow-up is a
  new branch off `main`, never more commits on the merged one.

## Releasing

Tags are `vX.Y.Z`. The release workflow refuses to run unless `package.json`,
`apps/web/package.json` and `apps/auth/package.json` all say `X.Y.Z`, so bump
those three first, then tag the merge commit that carries them.

A beta is one command, `make release-beta` (`scripts/release-beta.sh`): it bumps
the three files to the next `-beta.N` on a `release/vX.Y.Z-beta.N` branch, opens
the pull request, waits for its checks, merges it, deletes the branch and pushes
an annotated tag on the merge commit. It needs an authenticated `gh`; without
one it stops after pushing the branch, and `./scripts/release-beta.sh --tag`
tags once the pull request is merged. `--dry-run` prints every step and changes
nothing, `--version X` releases X instead of the next beta. By hand it is the
same three bumps, then:

```sh
git tag -a v0.1.0 -m v0.1.0 <merge commit> && git push origin v0.1.0
```

That publishes `manager`, `auth` and `nginx` to `ghcr.io/<owner>` and attaches
`install.sh` and `compose.yml` to the GitHub release.

**The first release needs one manual step.** Packages pushed by a workflow are
private, and an installer on someone else's VPS pulls anonymously. After the
first successful run, open each package under
`github.com/<owner>?tab=packages` and set its visibility to Public. Verify from
a logged-out machine before announcing anything:

```sh
docker logout ghcr.io
docker pull ghcr.io/<owner>/manager:latest
```

Images are `linux/amd64` only, and the installer refuses to run anywhere else.
