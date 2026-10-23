# Unlisted rooms implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` inline with TDD and a fresh whole-branch reviewer. The maintainer authorized planning and implementation after each merge; publish one new PR and wait for their merge.

**Goal:** Hosts can create or hide an open room and share its scoped link without directory or Quick Join discovery.

**Architecture:** Add a sparse listing intent to existing create/update commands. Persist its value in canonical group metadata and compute it before the existing CAS transaction; preserve listing across unrelated metadata replacement. Directory and Quick Join share interpretation; both games reuse the room entry owner.

**Tech Stack:** TypeScript, Vitest, Deno/Hono, AppInbox/QueueBox, React, Playwright.

**Spec:** [slice 5 design](lobby-unlisted-rooms-design.md), constrained by [lobby roadmap](lobby-and-matchmaking.md).

## Global constraints

- Add no legacy path, duplicated implementation, or migration code. Existing public visibility is preserved.
- `Group.metadata.rallarDirectoryListing` is `listed` or `unlisted`; absence is the current feature's listed default. Corrupt present settings are hidden.
- Admission credentials, scope, authorization, capacity, lifecycle and application participation retain their existing owners.
- AppInbox owns one read/compute/validate/write attempt per delivery, optimistic conflict redelivery, and atomic state/event/receipt/result/outbox persistence.
- Every changed human-authored file is reviewed/remediated in full; support files modified by remediation enter closure recursively; independent untouched code is outside closure.
- The GitHub PR owns delivery evidence. Do not merge or enable auto-merge. Delete this completed implementation plan and design in the completing PR; preserve durable behavior in product/API/example docs.

## Review focus

1. Generic metadata replacement cannot silently relist a hidden room.
2. Omitted listing retains existing command semantics/hashes and durable decoding.
3. Quick Join cannot commit a candidate hidden after its read.
4. An old directory ETag cannot preserve a room removed from listing.
5. Late host-control responses cannot update a different room/account's UI.

## Baseline and legacy exit

Base is merged #700, `c9fd1f84361fe4f4671a19b1bdf8d240e22a376a`. The clean linked worktree is reused on `codex/lobby-unlisted-rooms`. Existing create/update, snapshot visibility, Quick Join and room entry are canonical owners. No alternate join/discovery implementation is introduced. Classify each affected path as resolved/removed after tracing from entry to result; no retained legacy is planned. Any meaningful retained compatibility requires the repository's explicit approval and registry process.

## Task 1: Authoritative listing and discovery

**Files:**

- Create `packages/shared/api/group-directory/group-directory-listing.ts` for canonical interpretation and type.
- Modify `packages/shared/api/state-types.ts`, server `group-mutation-command.ts`, `mutation/group-mutation-contracts.ts`, request/command validation and aggregate create/update compute.
- Modify `policy/group-snapshot-visibility-policy.ts` and `quick-join/compute-group-quick-join.ts` to exclude hidden/corrupt listing.
- Test `packages/tests/shared-server/rallar-system/group-state/inbox/group-directory-listing.test.ts` and `apps/api-v1/test/group-state/group-state-directory-route.test.ts`.
- Update `apps/api-v1/resources/api-v1-openapi.yaml` and add a focused recipe beside existing API-v1 group-directory recipes.

**Interfaces:**

- Produce `GroupDirectoryListing = 'listed' | 'unlisted'` and `toGroupDirectoryListing(metadata: ApiJsonObject): GroupDirectoryListing | null` (null is corrupt).
- Create/update requests and command inputs accept optional `directoryListing`; omit it from normalized commands when absent.
- Existing `Group` output carries the setting in metadata. No new repository or transaction phase.

- [x] Write tests proving an open metadata-unlisted room is absent from discovery/Quick Join but accepts direct entry; missing listing stays listed; private credentials stay hidden; corrupt listing is hidden.
- [x] Run `npx vitest run packages/tests/shared-server/rallar-system/group-state/inbox/group-directory-listing.test.ts`. Expected RED from current discovery admitting the hidden room.
- [x] Implement canonical reader and discovery filtering; rerun that test to GREEN.
- [x] Add create/update AppInbox tests for listing-only intent, ordinary-member denial, exact replay, mismatched reuse, unrelated metadata preservation, same-setting no-op and a conflict followed by fresh rebase; verify RED before implementing intent flow.
- [x] Implement validation, normalization and pure metadata computation. Run the new tests and existing group-state inbox/mutation suites. Expected PASS with no repeated event or lost committed metadata.
- [x] Add the route/black-box scenario: list public room with ETag, hide it, revalidate old ETag and observe removal, direct join succeeds, relist returns it for a new outsider. Existing memberships/presence survive hiding. Add explicit create/update OpenAPI documentation.
- [x] Run focused Deno route tests, `deno task check` in API-v1, and the focused memory black-box recipe. Expected PASS. Commit the cohesive authoritative behavior.

## Task 2: Host controls and full delivery

**Files:**

- Modify `packages/shared-web/browser/rooms/{rallar-room-contracts,room-group-state-translation,create-and-join-room,update-room}.ts` and their focused tests.
- Extend current AR Eye and Relic hosting panels, runtime create inputs and existing shared entry copy; rename private-only hosting owners when their responsibilities broaden.
- Add visible-control tests beside `tests/playwright/{ar-eye-hunter,relic-hunters}/*private-room-entry.spec.ts`, using the existing separate guest-browser fixture.
- Update `docs/{product,architecture,rallar-api-reference}.md`, startup example and ongoing roadmap; retire completed implementation/design files.

**Interfaces:**

- Consume Task 1's canonical type/reader and create/update intent.
- Produce browser create/update `directoryListing` support; game controls call those existing operations and use authoritative snapshots.
- Scoped links use `toRoomEntryUrl(..., {roomRef, joinCode: null})` and the existing `RallarRoomEntry` lifecycle.

- [x] Add browser translation/workflow tests for unlisted create and listing-only update; run RED, then pass intent through the translation boundary. Run the focused room tests; include public API/bundle checks in final validation.
- [x] Add visible-control acceptance for each game: create unlisted, share link, outsider directory excludes it, enter by link, explicitly participate, host lists/unlists without ejecting the guest, unavailable mutation retains current control state. Verify RED before controls exist.
- [x] Extend existing host UI with New unlisted and List/Unlist controls plus clear link-only admission copy; retain code and invite workflows. Fence obsolete host response state by current session and room identity. Rerun focused acceptance to GREEN.
- [ ] Run both game builds and focused unit suites; run `npm run pr:delivery -- status` before broad final validation. Resolve real conflicts first; BEHIND alone does not create work.
- [ ] Run affected shared/server/API tests, `npm run typecheck:tests`, style and structure checks, navigation trace and cold probe; run mandatory Postgres medium-scale and comparative state-write benchmark with unchanged limits. Preserve hosted evidence in the PR.
- [ ] Fresh whole-branch review. Address substantive findings with RED/GREEN and applicable suites; close touched-file standards and affected legacy review.
- [ ] Update durable docs and roadmap with actual evidence, retire this plan/design, push the final branch. Run ready once without arming auto-merge. Wait for maintainer merge before starting reconnect/recent-room work.

## Evidence-driven closure

Both visible unlisted journeys pass. Relic's development profile exposed a broader snapshot list than
the dedicated directory; both game lists now apply the canonical listing reader to outsider rows and
retain active members' rooms. Existing strict snapshot authorization remains unchanged.

Standards closure makes the existing descriptor operation/request relationship explicit, removes
case-local casts in request normalization, and returns aggregate policy denials as computed results.
Request validation now carries JSON values after its existing JSON boundary check. These are part of
the same two increments; no third slice, migration, or alternate mutation path is introduced.
