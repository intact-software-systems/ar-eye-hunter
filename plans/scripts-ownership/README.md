# Scripts ownership

These documents are the review spec for moving `scripts/**` so shared repository
tools, platform harnesses, single-app scripts, and the hosted Rallar fleet each
have a visible owner. They are not a progress ledger. Implementation pull
requests do not write status back into this directory.

`plans/README.md` treats `plans/` as historical reference. This subdirectory is
the explicit exception created so the move can be reviewed before any script
moves.

## Decisions

- Hard cutover. Each slice updates every live caller and deletes the old path
  in the same change. No wrapper file remains at the old path.
- Two slices are concrete. Later regrouping stays outcome-shaped until both
  slices have landed.
- Leave historical text unchanged: existing files under `plans/` other than
  this directory, `playground/`, and `docs/superpowers/plans/`.
- Update live callers: `package.json`, workflows, tests, current skills,
  `AGENTS.md`, checker path keys, and operator docs that tell someone to run
  the moved command.
- Preserve each moved group's internal layout so relative imports inside the
  group stay valid. Fix only imports and path strings that pointed outside the
  group or named the old location.
- Imports point from a use-case toward repository and platform helpers.

## Slices

1. [Split `scripts/perf`](01-split-perf.md). API-v1 harnesses move beside
   API-v1. The recipe-console bench moves beside the black-box app.
   Shared-server benches move to `scripts/platform/perf/`.
2. [Hosted Rallar fleet](02-hosted-rallar.md). The controller directory, the
   dispatch script, the Actions materializers, and the distributed-validation
   risk command become siblings under `scripts/hosted-rallar/`. The controller
   directory stays the unit copied to the VM.

## Later outcome

After both slices land, a later plan can move repository-process tools under
`scripts/repo/` and move `scripts/deploy/` plus `scripts/transaction-write-check/`
under `scripts/platform/`. This index does not task that work out. Slice 1
creates `scripts/platform/perf/` only. It leaves `scripts/deploy/` and
`scripts/transaction-write-check/` where they are.

## Ownership rule

| Owner                           | Home after the concrete slices                                   | What belongs there                                                           |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Repository process              | Stays at the current `scripts/` entries until the later outcome  | Style, structure, governance, delivery, legacy review, test coupling         |
| Platform, shared by server apps | `scripts/platform/perf/` in slice 1                              | Runtime, fanout, and SQL seed benches that import `shared-server`            |
| One app                         | `apps/api-v1/scripts/perf/` and `apps/rallar-black-box/scripts/` | Harnesses that import that app                                               |
| Hosted Rallar fleet             | `scripts/hosted-rallar/`                                         | Controller shell scripts, Actions materializers, distributed-validation risk |
