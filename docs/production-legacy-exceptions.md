# Production Legacy Exception Registry

This registry records the explicit human approvals that let a retained
production-legacy item survive an active plan. It is not a baseline of all
existing legacy and it never makes unreviewed legacy acceptable.

The active plan and its PR Human Review Record v2 own the full affected-surface
ledger. Add an entry here only after a human explicitly approves retention for
the exact candidate tree. No automated score or agent may approve retained
production legacy.

## Required entry fields

Each retained entry includes:

- Legacy exception ID: a stable, unique `production-legacy-...` identifier;
- Repository-relative path and symbol;
- Purpose;
- Canonical implementation owner;
- Consumer or operational dependency;
- Why removal is unsafe now;
- Minimization already performed;
- Approval date and human reviewer;
- Approved production candidate SHA;
- Compatibility tests, which protect compatibility rather than internal
  structure;
- Named owner; and
- Review or removal condition.
- GitHub PR review ID.

An entry is valid only for its recorded location, purpose, minimization,
condition, and approved production candidate SHA. A production change
invalidates the approval; re-review it and obtain new explicit human approval
before the plan completes. The registry may be recorded in a later,
evidence-only commit after approval. That later commit may change only this
registry; any production path changed after the approved production SHA
invalidates the approval.

## Approved retained production legacy

No approved retained production legacy is recorded yet.

### Entry format

```markdown
### production-legacy-<descriptive-id>

- Repository-relative path and symbol:
- Purpose:
- Canonical implementation owner:
- Consumer or operational dependency:
- Why removal is unsafe now:
- Minimization already performed:
- Approval date and human reviewer:
- Approved production candidate SHA:
- Compatibility tests:
- Named owner:
- Review or removal condition:
- GitHub PR review ID:
- PR Human Review Record v2 link:
```
