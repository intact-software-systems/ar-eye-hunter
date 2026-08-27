# Pull Request Delivery

`scripts/pull-request-delivery.mjs` owns the agent-facing `status` and `ready` commands and the
automation-only `publish-observation` command. For interactive delivery, the current Git branch
identifies the pull request; callers never supply a pull-request number, commit SHA, plan
identifier, digest, run identifier, or reviewer identity.

## Dataflow

1. `read-pull-request.mjs` reads the pull request associated with the current branch and the
   repository default branch through `gh`.
2. `derive-delivery-action.mjs` reduces that normalized live snapshot to one visible action.
3. `status` prints the action without side effects.
4. `ready-pull-request.mjs` may mark a draft ready. It arms native squash auto-merge only after
   GitHub reports the pull request approved. The command refreshes the same pull request after each
   mutation and then prints its current action.
5. `rtc-observation-pull-request.mjs` verifies one package-owned RTC archive before mutation,
   appends it on a disposable branch made from current remote `main`, opens or resumes the matching
   pull request, and arms native squash auto-merge. It never commits or pushes `main`.

Conflict and terminal states are resolved before any readiness mutation. `BEHIND` is never a repair
state when GitHub still reports the pull request mergeable. While review is required, `ready`
leaves auto-merge unarmed so an administrator can merge directly. If auto-merge was armed through
another path, status tells the administrator to disable it on that PR first. `ready` never performs
an immediate or administrator merge.

Check state comes only from the newest `Branch Release Gate result` on the current pull request
revision. A missing result is pending; failures and pending states from unrelated or retired checks
are report-only and do not create agent work.

## Commands

```bash
npm run pr:delivery -- status
npm run pr:delivery -- ready
npm run pr:delivery -- publish-observation \
  --archive=/path/to/observation.zip \
  --index-entry=/path/to/index-entry.jsonl \
  --run-id=123456789 \
  --run-attempt=1
```

The output action is one of `OPEN_DRAFT`, `WORK`, `STOP_CLOSED`, `DONE`, `STOP_WRONG_BASE`,
`WAIT_GITHUB`, `REPAIR_CONFLICT`, `REPAIR_CHECK`, `WAIT_CI`,
`AWAIT_REVIEW_OR_ADMIN_MERGE`, `ARM_AUTO_MERGE`, or `WAIT_MERGE`. `DONE` is terminal and permits no
post-merge governance mutation.

GitHub authentication, network, and permission errors remain visible. If native auto-merge cannot
be armed, the command reports the original GitHub error and returns
`AWAIT_REVIEW_OR_ADMIN_MERGE`; an authorized administrator may use GitHub directly.

Scheduled RTC publication uses `RTC_OBSERVATION_PR_TOKEN` as `GH_TOKEN`. That automation
credential needs only repository Contents and Pull Requests write access, and its events must run
ordinary pull-request checks. A missing or insufficient credential fails closed after the capture
has already been retained as a workflow artifact. The restricted governance App is not used for
ordinary observation pull requests.
