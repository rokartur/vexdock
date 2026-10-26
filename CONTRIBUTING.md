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
make dev-up             # builds the four images, starts the stack
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

**UI.** Arc UI's components (uiarc.dev) rebuilt by hand in `src/components/ui`,
one flat file each, nothing installed from the Arc registry: an
`@base-ui/react` primitive where Base UI has one (`render` instead of `asChild`,
`data-open`/`data-starting-style` instead of `data-state`), a native element
otherwise, Tailwind token classes instead of `var(--…)`, CSS transitions
instead of a motion library, and only the props a caller uses. Sizes, radii and
timings come from the tokens below, not Arc's defaults.
Pages go through the vocabulary first:
`src/components/primitives.tsx` maps them to the vocabulary the dashboard uses
(Page, Tabs, Section, FormSection, Cell, Field, Input, Select, Switch, Button,
IconButton, Status, Confirm, EmptyState), so a design change happens in one
file. The shell is a sidebar that is the same on every page, carrying every
destination and the project tree, and a header over the page; tables are `DataTable` in
`components/data-table.tsx`, its own primitive that pages import directly. A
page reaches for a `ui/*` component only for what the vocabulary has no word
for (a dialog, a dropdown menu, an alert).
The visual language is the ui skill's Arc system (`src/styles.css`, the only palette there is): a
black canvas, cards a shade lighter resting on a hairline border with no shadow, hover,
selection and lines in translucent white so they read one step above whatever they sit on, the
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
a title, controls, then a footer strip with a hint on the left
and that card's own Save on the right. `SaveButton` is handed the card's
mutation so it can answer for two seconds after the write lands, and its `dirty`
so only a card with unsaved edits shows a primary Save. `aside` is the
read-only facts column next to the controls, and a card that also adds to a
list puts the table in its body and the add form in a `FormDialog` opened from
its actions, never under the table. Likewise a record opened from a list (a
deployment's pipeline, a container's log) is a `DetailDialog`, never a row
unfolded under the one clicked: `DataTable`'s `detail` does that for you.

The look is carried by tokens, not by classes on pages: `src/styles.css` is
the ui skill's `styles.css` unchanged, then vexdock's own additions under it
(the console colors, the base
layer, `enter-children`). It resets every Tailwind default it does not define,
so an off-system class (`rounded-lg`, `font-semibold`, `bg-zinc-800`,
`text-6xl`) produces no CSS at all. Text is
`text-xs` to `text-5xl` in Inter, Geist (`font-display`) from `text-3xl` up,
`font-mono` for machine output (console, code, ids); weights are
`font-normal` and `font-medium`. Controls are `h-control-sm|md|lg` (28/36/44px)
and corners `rounded-control|panel|surface` (10/14/18px), so no component writes
a size of its own. Classes merge with `import { cn } from 'cn'`.
A card is `rounded-surface border bg-surface` and floats nothing: only menus,
popovers and dialogs get `shadow-floating`.
Hairlines come in two weights, and using the wrong one flattens the page:
`border-border` is a container's own edge, `border-border-subtle` is a separator
inside one and is quieter. Tables separate rows with it, readings share one
frame in a `Cells` grid with a hairline between them, a state is an Arc `Badge` whose tone
carries the color (`Status`), and attributes are read as a `Facts` list: label
left, value right, a rule between rows.

Motion is a token too. The `popup` and `scrim` utilities and the
`ease-enter|standard|exit|spring` tokens time every popover, menu, select,
dialog and tooltip without a page naming it, as CSS transitions. Reduced motion
cuts every CSS transition and animation to 0.01ms (the base layer in
`styles.css`); `MotionConfig reducedMotion='user'` drops the travel of the
`motion/react` slides. Page
blocks enter staggered (`enter-children` on `Page`), a selection slides
(`ActivePill`), a panel's height follows `--collapsible-panel-height` on a
Base UI `Collapsible`, and a live reading rolls its digits (`AnimatedNumber`).
`ActivePill` is the one `motion/react` user: a highlight sliding between rows in
different containers (`layoutId`) is the one thing CSS cannot do. Nothing
loops: a busy button shows a static glyph, not a spinner.

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

That publishes `manager`, `auth`, `mcp` and `nginx` to `ghcr.io/<owner>/vexdock` and
attaches `install.sh` and `compose.yml` to the GitHub release.

**The first release of an image needs one manual step.** Packages pushed by a
workflow are private, and an installer on someone else's VPS pulls anonymously.
After the first successful run that publishes a new image (all four moved under
`vexdock/` in 0.1.2-beta.3), open that package under `github.com/<owner>?tab=packages` and
set its visibility to Public. Verify from a logged-out machine before
announcing anything:

```sh
docker logout ghcr.io
docker pull ghcr.io/<owner>/vexdock/manager:latest
```

Images are `linux/amd64` only, and the installer refuses to run anywhere else.
