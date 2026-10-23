# Shareable private room entry implementation plan

> Implement with `superpowers:executing-plans` and test-driven development. The live pull request owns
> delivery and validation evidence. Only the next two useful increments are concrete here.

**Goal:** A person can create and share a private room, open its invitation in a fresh browser,
authenticate, enter the intended room, participate, and reload without losing that destination.

**Architecture:** Reuse canonical group admission, invitation, code rotation, and AppInbox operations.
One shared browser entry owner carries the scoped destination through authentication and reload;
applications own their controls and activity participation. No code lookup registry or stored server
shape is added.

**Tech stack:** Existing TypeScript, Rallar browser/server packages, React, Vitest, Deno, PostgreSQL,
and Playwright. Add no dependency.

**Spec:** [Lobby and matchmaking product plan, slice 4](lobby-and-matchmaking.md#slice-4-shareable-private-rooms).
The product direction originated in [PR #695](https://github.com/intact-software-systems/ar-eye-hunter/pull/695).
The starting main includes directory hardening, Quick Join, and existing-measurement RTT discovery.

## Constraints and approach

- No legacy, duplicated implementation, migration code, fallback protocol, or new persisted server
  format. Prefer existing repository patterns. Required authoritative fields remain required.
- Code-protected and invite-only rooms remain hidden from the open directory. Unlisted rooms and a
  general recent-room product belong to later slices.
- A link carries the exact `GroupRef` and, for a code room, its code. It carries no auth credentials,
  server address, session, or ticket. The receiving app accepts only its configured scope.
  Preserve AR Eye's `ar-eye-hunter/default` and Relic's current `rallar-server/default` scope; this
  feature does not rename or migrate either app's rooms.
- Manual entry asks for a room reference and code within that app's scope. This is the builder's
  stated working choice, based on existing contracts, not a claim that codes are globally unique.
- Account invitations authorize a principal through existing group membership. A share link alone
  cannot authorize an uninvited account. Known people may be selected by username/display name;
  presence is not presented as friendship. The authenticated people collection exposes only the
  caller's own profile; it is not a username directory. Show each signed-in person's account
  reference so guests can share it with a host for a targeted invitation. Keep known-person labels
  where available, without widening the existing read-authorization boundary.
- Preserve default seven-day code and invitation lifetimes already owned by the server. Display the
  expiry returned by rotation. Expired and mismatched codes share the existing denial; say invalid
  or expired rather than claiming to distinguish rotation from expiry.
- A new invitation outranks an old restored room. Failure must leave the intended destination
  visible and offer retry, correction, or cancellation; never silently enter another room.
- Code rotation stops future admission through the old code and leaves active membership intact.
  Reload uses current membership, not a retained old code. Removed/banned members and inactive or
  expired rooms remain denied.
- Admission and gameplay are separate. Relic must still require the existing Join Expedition action.
  AR Eye retains its director/match lifecycle. HTTP success alone is not participation evidence.
- Review and remediate every changed human-authored file in full. Support files modified by that
  remediation enter closure recursively. Independent untouched code remains outside closure.
- Wait for the maintainer to merge the completed PR before starting the next product slice. Do not
  arm auto-merge or merge on the maintainer's behalf.

### Approaches considered

Use scoped room references with existing admission commands. This keeps one authority for capacity,
membership, invitation expiry, and code rotation, and makes links work across authentication without
a new public resolver. Manual entry needs both the room reference and its code.

A scoped short-code resolver would make manual entry shorter, but needs new uniqueness, lookup,
expiry, privacy, and contention contracts. Existing codes are room-local and callers can choose
them. That larger capability is not required by the accepted product plan and is not introduced.

## Current owners and dataflow

- `packages/shared-web/browser/rooms/browser-rallar-rooms.ts` composes the public room facade.
  `room-membership.ts` exposes invitation creation and acceptance. Existing
  `room-membership-group-state-workflows.ts` already owns revoke and rotate HTTP workflows; add
  narrow facade access to those operations rather than another HTTP implementation.
- `join-room.ts` owns scoped room adoption and leaving the previous current room. Quick Join has a
  session/signal fence; ordinary join currently does not have the same explicit completion fence.
  Keep adoption and previous-room cleanup under the initiating session and destination attempt.
- `packages/shared-server/rallar-system/group-state/mutation/membership/compute-group-membership-mutation.ts`
  calls `canJoinGroup` before its active-member no-op. The code policy currently requires a code even
  for an active member. Pin the product's return-after-rotation rule before correcting that policy.
- Group routes enqueue the existing AppInbox operations. Their fresh reads, pure computation,
  validation, aggregate revision guard, durable completion, and outer QueueBox retry remain canonical.
- AR Eye startup is `use-arena-connection-session-lifecycle.ts`; room actions live in
  `use-arena-session-actions.ts`, with UI in `arena-ui/arena-operations.tsx` and composition in `app.tsx`.
- Relic startup/hydration is `game/relic-hunters-runtime.ts`, consumed by `useRelicHunters.ts` and
  `App.tsx`. It currently restores a bare room ID from local storage. Replace affected duplicate
  restoration with the shared scoped entry owner; no dual-read migration path.
- Both apps subscribe to room state. Relic's `applyRoomState` hydrates a changed room, while expedition
  membership remains a separate command. Keep that authority boundary visible.
- Relevant existing example: `examples/browser-startup-room`. Update its canonical entry example
  after the shared contract is usable.

## Shared browser contract

Create `packages/shared-web/browser/rooms/rallar-room-entry.ts` as the explicit owner of pending entry
and current-room return. Its type-only `RallarRoomEntry` namespace precedes the class. Pure URL
encoding/decoding stays beside this capability, with a narrow public entry point if needed to keep
optional entry logic out of the base facade bundle.

The destination is `{ roomRef: GroupRef, joinCode: string | null }`. A fragment identifies that
destination without sending the code in the initial page request. Parsing rejects malformed,
ambiguous, unsupported, and wrong-scope values. Do not accept a destination-supplied API host.

The class receives auth, room operations, browser storage, and URL read/replace capabilities through
explicit dependencies. Apps construct one owner, capture the incoming link before startup, subscribe
for rendering, resume after authenticated startup, and stop subscriptions/attempts on cleanup.

Its public operations are `getState()`, `start()`, `enter(destination)`, `resume()`, `cancel()`,
`onChange(listener)`, and `stop()`. Expected failures are typed values/state; use the repo's `Either`
at decoding and effect boundaries. A state carries the destination, status, and typed failure so a
consumer cannot confuse admission failure with an empty lobby.

Persist the pending destination in tab-local storage before cleaning the URL. A fresh link replaces
the old destination. Successful entry removes the code and retains only the room reference and
principal identity needed for reload. Returning as another principal must not reuse that saved
membership. Storage failure is visible and cannot claim reload persistence or discard the only
recoverable destination. No auth token or session is written by this owner.

Use the existing `SingleFlight` primitive if coalescing repeated resume calls is necessary. A new
destination, cancellation, stopped lifecycle, or replaced auth session aborts the old attempt and
prevents it from adopting room state or leaving a room under the new session. Server admission that
already committed cannot be undone by browser cancellation; report partial completion truthfully.

Add `rooms.rotateJoinCode(room, options)` returning the canonical `GroupJoinCodeResponse`, plus
`rooms.revokeInvite(room, principalId, options)` using the existing workflows. Preserve canonical
names and snapshot acceptance; do not rename server response types or duplicate request construction.

## Review focus

1. A second link or account replaces the first while admission is in flight: the old result cannot
   select a room, clear the new destination, or leave the new account's room.
2. A member reloads after code rotation or expiry: membership survives, while a new entrant using
   the old code is denied. Removed/banned membership must never be resurrected.
3. Admission commits but presence or old-room cleanup fails: retain the actual admitted destination
   and provide honest retry/partial-failure feedback.
4. An invitation fails during authentication or storage is unavailable: preserve recoverability,
   distinguish denial from network failure, and do not fall back to an unrelated restored room.
5. Wrong-scope links and duplicate/malformed fragment fields: reject them before network effects,
   keep private rooms absent from discovery, and never reinterpret scope from a warm cache.

## Increment 1: canonical private-room entry and return

**Files and ownership:**

- Create shared `rallar-room-entry.ts` and mirrored `packages/tests/shared-web/rooms/rallar-room-entry.test.ts`.
- Modify `browser-rallar-rooms.ts`, `rallar-room-contracts.ts`, `room-membership.ts`, and the existing
  mutation boundary only as needed for typed rotate/revoke results and session-safe snapshot adoption.
- Modify `join-room.ts` and its existing workflow if needed to fence each transport/adoption boundary
  and preserve truthful partial completion.
- Correct the active-member credential policy in
  `packages/shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts` after
  the direct regression test is red. Keep lifecycle, capacity, and blocked-member checks intact.
- Extend existing policy, membership, AppInbox, browser workflow, and REST black-box admission tests;
  update the existing public API snapshot tests for intentional new exports/methods.

**Interfaces:** The class contract above and the two narrow facade methods are the only new browser
capabilities. Existing group HTTP and AppInbox command contracts remain the mutation authority.

- [x] Add failing semantic tests for active-member return with an expired/rotated code and new-entry
      denial, including removed/banned and inactive/expired variants. Assert authoritative membership,
      denial, and event/receipt outcomes rather than helper invocation topology.
- [x] Run the focused policy/membership tests and confirm the intended regression, then implement the
      policy correction and rerun them.
- [x] Add failing shared browser tests for exact URL round-trip/scope rejection, pending sign-in and
      reload, new-link precedence, storage failure, account replacement, cancellation, and partial join.
- [x] Implement the shared owner and reuse existing invitation/code workflows. Add observable facade
      tests for result/snapshot acceptance and obsolete-session completion.
- [x] Run `npx vitest run packages/tests/shared-web/rooms`, the affected server tests, and
      `npm --workspace @ar-eye-hunter/shared-web run typecheck`. Review changed production files and
      commit the coherent shared capability.

**Legacy exit:** No parallel join algorithm, old/new URL format, dual-read storage bridge, or new
transaction/retry owner. Existing public APIs remain canonical, with additive rotate/revoke access.

The first checkpoint fixes active-member return and ordinary join completion fencing. Seven direct
AppInbox scenarios cover rotation, expiry, replay, blocked membership, and inactive rooms. The
browser regression suite covers session/account replacement, cancellation, partial admission, and
401 cleanup beneath the partial-failure cause. The latter required the auth lifecycle to inspect
the cause chain. Policy-only plaintext credential fallbacks without production consumers were
removed; code verifiers and principal invitations remain canonical.

The shared entry owner now preserves the scoped destination through sign-in and reload, removes the
code after admission, fences obsolete attempts, and handles storage, denial, and partial completion
explicitly. Same-tab invitation changes replace an in-flight destination. The room facade exposes
rotation and revocation through existing HTTP workflows, checks session ownership before retries and
snapshot adoption, and returns the canonical code/expiry response. The optional entry point stays
outside the base facade bundle. Changed callbacks now delegate complete workflows to named operations;
the shared session fence owns account/session identity checks. App controls and full-stack validation
remain pending. The live PR records validation evidence.

## Increment 2: create, share, enter, and participate in both games

**Files and ownership:**

- AR Eye app composition, session startup/actions, and arena operations UI own game presentation and
  connect the shared entry owner. Add focused room-entry UI alongside the existing operations panel.
- Relic app composition, startup/runtime, hook, and room/auth presentation consume the same owner.
  Separate coherent lobby/auth presentation from the large existing `App.tsx` when touching it;
  close standards across every changed file and recursively changed support file.
- Add visible-control Playwright scenarios under `tests/playwright/ar-eye-hunter` and
  `tests/playwright/relic-hunters`; register them in the owning configs and existing CI lanes.
- Update the browser startup example, relevant product docs, public API snapshots, and the continuing
  product plan. Delete this implementation plan in the PR that completes it.

**Interfaces:** Consume Increment 1's entry owner and `rooms.rotateJoinCode`/`revokeInvite`. Keep
game creation through `rooms.createAndSwitch`, room membership through canonical room operations,
and Relic expedition commands in its runtime.

- [ ] Write failing UI tests for manual room-reference/code entry while signed out, visible pending
      destination through login/registration, retry/cancel, and host sharing/rotation.
- [ ] Add private creation choices to both apps while preserving existing public creation. Code rooms
      expose a copyable link, room reference, code, and returned expiry. Invite-only rooms expose known
      account selection, invitation/revocation, and a reference link. Clear stale generated credentials
      on session/room changes and rotation failure; never display an old code as the new one.
- [ ] Wire authenticated startup to resume the shared destination before restoring an old room.
      Retain one scoped restoration implementation and explicit application participation controls.
- [ ] Drive two fresh browsers through host creation, sharing, login, entry, participation, rotation,
      invalid/expired feedback, and reload. Include an uninvited account, a wrong-scope destination,
      cancellation, and a new invitation overriding an old current room.
- [ ] Run focused app tests, `npm run build:ar-eye-hunter-v1`, and `npm run build:relic-hunters-v1`.
      Run both configured Playwright flows and inspect resulting screenshots/state.
- [ ] Complete affected code, structure, and legacy review; publish the completed slice and wait for
      the maintainer's merge.

**Legacy exit:** The affected bare-ID Relic restore is removed, not retained as fallback. Any other
affected legacy without a verified independent consumer is removed. UI extraction preserves current
activity behavior and does not carry a duplicate predecessor implementation.

The AR Eye checkpoint now includes private creation, share links, manual entry, code rotation,
principal invitations and revocation, and account-reference display. Ten combined visible-control
browser scenarios passed against a fresh in-memory API, including actual match participation, member
reload after rotation, rejected and corrected credentials, and a new destination replacing a saved
room. The existing browser CI lane runs that same scenario set sequentially because the demo accounts
and empty-directory assertion share server state. Real-browser reload exposed cancelled startup
poisoning a replacement connection; a failing startup regression now protects the canonical
cancellation result. Creation also fences the initiating session and preserves the newly adopted room
when previous-room membership cannot be left. Relic integration and the remaining final gates are
still pending; the increment remains open.

## Final validation and delivery

Run `npm run pr:delivery -- status` before broad validation; repair actual conflicts/check failures.
Do not refresh the branch solely for `BEHIND` when GitHub reports it mergeable.

- Focused shared-web entry/join/membership tests; affected group-policy/membership/AppInbox tests.
- Shared-web typecheck; both app tests/builds; shared-web public API snapshots and browser bundle
  boundaries. Preserve the existing facade bundle budget; optional entry code gets a narrow import.
- Existing group-admission black-box coverage plus added rotation/return cases. Because an admission
  policy changes, run the unweakened PostgreSQL medium-scale gate and state-write comparative gate.
- Real PostgreSQL conflict/replay/rollback tests relevant to the policy path; one attempt per delivery
  and fresh reauthorization remain required. Record both registration and invocation traces and the
  five-landmark navigation probe if authoritative control flow changes.
- Visible-control Playwright for both apps, including reload and actual participation. Do not count
  a URL-only bootstrap test or an HTTP response as the full acceptance proof.
- Formatting, `git diff --check`, affected repository style/construction review, repository structure,
  test structure/reachability, and repo-governance checks for changed active docs/examples.
- One fresh whole-branch review, current PR body, green affected CI, and one
  `npm run pr:delivery -- ready` at handoff. Report passed, failed, and skipped checks honestly.

The PR contains Goal, Changes, Acceptance, Validation, Risk and rollback, and Follow-up. Rollback is
reverting this slice; no stored server format requires migration. The continuing lobby plan remains
outcome-shaped beyond this slice. No new issue is needed unless evidence exposes independent work.
