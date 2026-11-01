# Friends and invitations implementation plan

**Goal:** Find known people, mutually accept friendship, and invite them back into actual play in both games.

**Architecture:** Account-level consent is a shared-server capability over the existing RuntimeState repository and AppInbox transaction owner. Browser lifecycle belongs in shared-web; one shared-react panel serves both apps. Existing room entry and scheduled-session owners retain admission and gameplay authority.

**Specification:** The approved conversation scope and privacy default: mutual acceptance; current room location is never disclosed by presence; explicit invitations disclose only their destination. No legacy, migration code, duplicate mechanisms, or React outside shared-react and apps.

## Acceptance and review focus

- Send, accept, decline, cancel, remove, block and unblock from visible controls. Reciprocal requests do not silently accept friendship.
- One account-level list across games; invitations remain scoped by application and workspace. Exact username entry avoids publishing an account directory.
- Presence sharing is explicit and can be disabled. Public friend projections never contain raw sessions, authentication records or current room references.
- Block/remove immediately revoke friendship visibility and pending social invitations; they do not remove independent room memberships. Unblock does not restore consent.
- Invitation acceptance is an explicit action through current room entry or scheduled-session preview/RSVP. No automatic room switch, saved code or admission bypass.
- Reload, account change, another tab, stale consent, revocation, capacity, expired rooms and duplicate requests must have truthful outcomes.
- Incoming writes use read/compute/validate/write through AppInbox, fresh authorization per retry, exact replay and optimistic conditional writes. Persisted malformed rows fail closed.

## Next two implementation increments (one PR)

### 1. Durable consent and private invitation capability

Owners: packages/shared/api/friends, packages/shared-server/rallar-system/friends, apps/api-v1/src/friends. Reuse auth repositories, RuntimeState optimistic writes and RallarServerAppInbox; do not add tables or migration readers.

- Write failing policy tests for mutual consent, cancellation versus accept, reciprocal requests, blocking and visibility.
- Implement pure contact transitions and exact contracts; run focused Vitest and shared/server typechecks.
- Add real database/AppInbox tests for overlapping writers, rollback, stale authorization, replay, conflicting identity reuse and corrupt storage. Implement the owner with fully computed writes before transaction entry.
- Expose authenticated self-only reads and request-ID-bound mutations with OpenAPI and black-box coverage; test unauthorized reads and invitation destination validation.
- Publish the first coherent commit and draft PR with current acceptance and validation evidence.

### 2. Both games' complete clickable experience

Owners: packages/shared-web/browser/friends, packages/shared-react/friends-panel.tsx, both games' room UI, mirrored package tests and tests/playwright.

- Write failing browser lifecycle tests for account replacement, foreground refresh and failure retention; reuse existing notification, cancellation and repeating-work primitives.
- Implement one shared friends owner and shared React UI. Reuse room entry and scheduled-session preview, with game-specific participation remaining in apps.
- Add two-account clickable journeys in each game: request/accept, visibility, invite/enter, actual shared play, reload, remove/block and stale invitation refusal.
- Validate public API/bundle boundaries, app tests/builds, focused API recipes, PostgreSQL integration, medium-scale and controlled state-write performance. Use local and hosted runs, including GitHub Free Distributed Recipe for changed recipes and Hetzner when distributed risk requires it.
- Review complete touched files and recursively modified support files; independent untouched code stays excluded. Perform mutation navigation and legacy review. Update product documentation and PR, delete this completed plan before readiness, and obtain green CI.

## Validation commands

Focused: `npx vitest run packages/tests/shared-server/rallar-system/friends`.
Types: `npx tsc -p packages/shared-server/tsconfig.json --noEmit` and affected shared/shared-web/shared-react checks.
Apps: `npm --workspace ar-eye-hunter-v1 run build`; `npm --workspace relic-hunters-v1 run build`.
Use the repository testing skill for exact browser and hosted commands after test entry points are selected. Run Deno with `DENO_NO_PACKAGE_JSON=1`.

## Legacy boundary

This is new consent policy; existing people presence is not friendship and is not repurposed into permission. Reuse existing live APIs without retaining predecessor implementations. No migration or dual readers are needed for new storage namespaces. Any existing touched-file noncompliance is resolved in the same PR.
