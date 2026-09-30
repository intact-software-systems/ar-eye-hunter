# Plans

Finished plans are inert historical reference material. They are not kept in
this directory. Git history is the archive. Documents here do not control
current repository work or pull-request delivery.

Current multi-slice work uses the agent's working plan and the live GitHub
pull request. Ordinary delivery does not update these files or create a
completion record here.

## Written plans

- `plans/backlog.md` names future outcomes in a few lines each. It is not an
  implementation plan and it does not track work that is underway.
- A written multi-slice spec, when one is useful, lives at
  `plans/active/<topic>.md`. The pull request remains the delivery record.
  There is no index of those files.
- The ALM design set stays at `playground/alm/`. It is current work. The
  snapshot readers in `playground/alm/tools/` belong to the hosted lifecycle
  diagnosis beside those documents.
- `docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md`
  stays because it is not finished: RTC-B06 has no accepted E3-memory primary
  and `RTC-B07` is held. Its status section names what pull request
  [#566](https://github.com/intact-software-systems/ar-eye-hunter/pull/566)
  delivered and what remains.

## When a plan is finished

The pull request that finishes a written plan deletes that plan file before merge, and removes the
keep-set line above that names it. Git history is the archive. After the pull request has merged,
that deletion is no longer part of the work.

A later deletion is allowed only when the outcomes are already in the tree or in a merged pull
request, no open pull request still modifies the path, and neither this file nor `docs/README.md`
names the plan as current work. If one of those checks fails, leave the file.

The keep-set is the ALM design and the RTC baseline plan named above. `plans/backlog.md` is not a
plan to delete.
