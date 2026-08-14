# Pull Request Delivery

`scripts/pull-request-delivery.mjs` owns the agent-facing `status` and `ready` commands. The current
Git branch identifies the pull request; callers never supply a pull-request number, commit SHA,
plan identifier, digest, run identifier, or reviewer identity.

## Dataflow

1. `read-pull-request.mjs` reads the pull request associated with the current branch and the
   repository default branch through `gh`.
2. `derive-delivery-action.mjs` reduces that normalized live snapshot to one visible action.
3. `status` prints the action without side effects.
4. `ready-pull-request.mjs` may mark a draft ready and arm native squash auto-merge. The command
   refreshes the same pull request after each mutation and then prints its current action.

Conflict and terminal states are resolved before any readiness mutation. `BEHIND` is never a repair
state when GitHub still reports the pull request mergeable. `ready` never performs an immediate or
administrator merge.

## Commands

```bash
npm run pr:delivery -- status
npm run pr:delivery -- ready
```

The output action is one of `OPEN_DRAFT`, `WORK`, `STOP_CLOSED`, `DONE`, `STOP_WRONG_BASE`,
`WAIT_GITHUB`, `REPAIR_CONFLICT`, `REPAIR_CHECK`, `WAIT_CI`,
`AWAIT_REVIEW_OR_ADMIN_MERGE`, `ARM_AUTO_MERGE`, or `WAIT_MERGE`. `DONE` is terminal and permits no
post-merge governance mutation.

GitHub authentication, network, and permission errors remain visible. If native auto-merge cannot
be armed, the command reports the original GitHub error and returns
`AWAIT_REVIEW_OR_ADMIN_MERGE`; an authorized administrator may use GitHub directly.
