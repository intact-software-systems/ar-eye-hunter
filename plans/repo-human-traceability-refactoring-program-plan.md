# Repository Human Traceability Refactoring Program Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement an approved child plan task by
> task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repository navigable by a human who follows filenames,
folders, dataflow, callers, and callees, while incrementally bringing existing
TypeScript into compliance with the repository coding standard.

**Architecture:** Organize production and test code by owned feature first and
by responsibility second. Preserve the existing package boundaries, establish
one explicit browser `room` to authoritative server `group-state` translation
boundary, and migrate one complete vertical feature slice at a time. Separate
behavior-preserving file moves from semantic code-standard changes so reviewers
can distinguish relocation from behavior changes.

**Tech Stack:** TypeScript, Deno, Node.js/npm workspaces, Hono, Vitest,
Playwright, PostgreSQL/PGlite, Markdown, the warning-only repository style
checker, and Git rename detection.

## Global Constraints

- The authoritative TypeScript standard remains
  `.agents/skills/rallar-code-writing/references/repo-code-style.md`.
- The standard applies repo-wide to `apps/**`, `packages/**`, `scripts/**`,
  examples, tests, and support tooling.
- New and changed code follows the standard. Existing violations are debt, not
  precedent.
- Keep `packages/shared`, `packages/shared-web`, `packages/shared-server`,
  `packages/shared-graph`, `packages/shared-test`, and `packages/tests` in their
  current runtime and ownership roles.
- Organize by feature or owned capability before technical role. Do not replace
  broad `services`, `types`, or `repositories` folders with broad
  `translators`, `factories`, or `interfaces` folders.
- `room` is the product and browser term. `group-state` is the authoritative API
  and server term. Translation between them occurs at one explicitly named
  browser boundary.
- Established protocol identity names such as `GroupRef` and `roomRef` remain
  unchanged unless a separately approved public-contract plan changes them.
- Preserve public exports, import paths, OpenAPI contracts, persisted formats,
  and behavior unless a child plan explicitly identifies and receives approval
  for a compatibility or breaking change.
- Incoming HTTP and WebSocket database mutations continue through AppInbox.
  AppInbox owns transaction and retry behavior, with visible `read`, `compute`,
  `validate`, and `write(transaction, computed)` phases.
- Authoritative persisted, replicated, queued, event, snapshot, receipt,
  result, and response fields remain mandatory by default.
- The full-repository checker remains warning-only. New or worsened branch
  findings are blocking through a merge-base comparison, without requiring
  unrelated legacy debt to be repaired.
- Do not run a repository-wide formatter, filename rewrite, optional-field
  rewrite, `type`-to-`interface` rewrite, or automated semantic codemod.
- Preserve unrelated working-tree changes and stage only files belonging to the
  active child plan.
- A plan or milestone is not complete until its required focused checks and the
  repository completion and publication gates have passed on the exact final
  code.

---

Date: 2026-07-28

Status: Reviewed and approved for child-plan drafting. The program documents are
published on `main`. The governance and checker child was approved at blob
`8ee56ac27189f9bed751fb6a95992830bda6be60` and is `ledger-published`. The
[browser room/group-state translation-boundary child](rallar-room-group-state-translation-boundary-plan.md)
was approved at Git blob
`37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` subject only to its explicitly
recorded narrow amendments. Structure/boundary Tasks 0 through 6 are
implemented and published through PR #53; alignment Tasks 7 and 8 are
implemented and published through PR #54. Both implementation envelopes are
green. Its separate evidence ledger was published through PR #55 and reached
`ledger-published` at resulting `main`
`b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`. The
[authoritative group-state server structure child](rallar-group-state-server-structure-plan.md)
is approved at Git blob `1a74159d37f76a459009e99ca5a08f3cd620b1b4` with its
authorized amendments. Its complete behavior-neutral implementation was
published through PR #59 at feature head
`bec8bea4eb095de9ad3a6b47c18e6799ab811239` and tree
`c1ac6a57dad974d04264cbe1fa92313697256712`, then squash-merged as exact
`main` SHA `06e0c5ab138c2ab55ac519b2244f727acd42d560`; the exact resulting-main
workflow is green. The post-publication
[server traceability QA child](rallar-group-state-server-traceability-qa-plan.md)
published guidance/lineage PR #61 and behavior-neutral runtime PR #62. PR #62
feature `b579aa56bc656b12f3717f2b02c0e24de9244357` and tree
`3a7d80a3a9c522ba4954168be5f380aee04f871b` passed Branch Release Gate
`30739771277` attempt 1, then squash-merged as exact `main`
`f124f8c3ac57e5f3a92c47f767f8b7e2b19e6af5`; default workflow
`30741608017` attempt 1 succeeded for that exact SHA. The linked
[server traceability hardening child](rallar-group-state-server-traceability-hardening-plan.md)
is complete through guidance/navigation PR #64 and behavior-neutral runtime PR
#65. PR #64 feature `6ce2bcce85f3a03446c847f4b07689c1c0b1e70e` and tree
`00d475e7d40bed7060567ee391ffe1041fba443a` passed Branch Release Gate
`30748239173` attempt 1, then squash-merged as exact `main`
`49237d8bb75d2239569aa4e3d43f8b88db799602` with the same tree; default workflow
`30749273740` attempt 1 succeeded for that exact SHA. PR #65 feature
`a7e429274a8776b8e1cc842da9c472a12feee224` and tree
`c1cd8fd529efec6486acb34f0d79e084e33141d0` passed Branch Release Gate
`30755181882` attempt 1, then squash-merged as exact `main`
`5a6ffd385655af75b28aa22feb5a7103f87862a0` with the same tree; default workflow
`30774354577` attempt 1 succeeded for that exact SHA. The separate server
evidence ledger was published through PR #66 and reached `ledger-published` at
exact resulting `main` `04b041824073e50a4f1623ca9a71d0d02b770c12` after
workflow `30780849548` attempt 1 succeeded. The
[API-v1 group-state route child](api-v1-group-state-route-structure-plan.md) was
approved at Git blob `00a8efe0e6124ec9882360c1328045cde781b726` subject only to
its recorded amendments. Structure PR #68 and code-standard alignment PR #69
are implemented and published through exact resulting `main`
`cff66107dfa13c47e117d9e1dbcfb8f6ae747ea3`; both implementation envelopes are
green. Its evidence ledger was published through PR #70 at feature head
`3ff182f65da7360974ad316033e4dad5eeeb8b12` and frozen tree
`8f9502ff3da6a1934e49cbd6d8b6a7508e5e7695`. Branch Release Gate run
`30861897688` attempt 1 passed for that feature head. PR #70 merged as exact
`main` SHA `44d1c9ff74f2d1a837f49c3a6ed696491788cd8c`, and **Run Hetzner
Supported Distributed Manifests** run `30864134072` attempt 1 passed for that
exact SHA. The API-v1 child is therefore `ledger-published`. The human approved
the pilot conclusions at exact master blob
`4172437a6ca3ef6008446a1797582b4e4b9406a9` and execution-plan blob
`3dc5495f5ee21b615a44f4e65c92deee8b42a940`. The linked
[authoritative client-state server child](rallar-client-state-server-structure-plan.md)
was approved at exact blob `71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`.
Planning PR #71 and implementation PRs #72, #73, and #74 are complete, merged,
and exact-default-workflow verified. The final implementation feature
`b57b6797e30139a6e77e669fb2c85291d40d9de7` / tree
`b61e02f0ddb3f22d4f68948f5c227b49c9bcdcf7` merged as exact `main`
`df9ab8d27de17c29b927c9ed9fcce9251ba7e62a`; workflow `31095762444`
attempt 1 succeeded for that exact SHA. Evidence-ledger PR #75 then reached
`ledger-published` at exact main `6b75cfc5ec61f81b465be9072b746d24ecdb5f22` after workflow
`31100952224` attempt 1 succeeded. The linked
[auth server structure child](rallar-auth-server-structure-plan.md) was approved at exact blob
`123990bceac9732660e1113101addd5b194d8347`. Planning PR #76 and implementation PRs #78,
#81, and #90 are complete through exact resulting main
`eb0c58c9ffbeb290dafa5cfaba6e5a005b2418b2`; default workflow `31241669511` attempt 1
succeeded for that exact SHA. Evidence-ledger PR #93 then published feature
`aeff6435794dd70816789e4794b78e84fdfc89b0` and frozen tree
`8bdea4402dad08dbd1892f2bd8c95671d615b8ff`, and merged as exact `main`
`c2cb79c020bceee7f67e6fbc364ba96ea0d6a530` with the same tree under the
human-approved plan-only build-gate exception. Run Hetzner Supported Distributed Manifests
`31251480014` attempt 1 failed and is retained only as non-gating external evidence for that
plan-only publication. The auth child is `ledger-published`. The group-topology
implementation is closed through PRs #103, #151, #155, and #209, merge
`44cda16e4633a27d4315dc3a3eb41405651e39c3`, authenticated
[closure receipt](rallar-group-topology-server-structure.closure.json), and
direct close-out main `8ee348e215a3e30d9b4959ce90369aea1b55b620`.
Its separately authorized
[evidence ledger](rallar-group-topology-evidence-ledger-plan.md) is active on
that exact base; the child is not `ledger-published` until the evidence-ledger
publication is merged and its external envelope is recorded.

Program drafting, approval, execution, publication, and human handoffs follow
the [Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md).
That execution protocol does not itself approve any child plan.

Approved execution decision on 2026-07-28:

- A public structural move may use one temporary compatibility re-export hop.
  Every concrete shim still requires explicit human approval in its child plan,
  must name the supported consumers, and must include a removal condition.
- The first browser room migration preserves the existing
  `RallarRoomsFacade` public return-type compatibility. Product-named public room
  contracts require a separate breaking-release plan and approval.
- A migration that crosses a public boundary, spans multiple packages, or
  touches more than approximately 20 files normally uses two pull requests:
  structure first, then code-standard alignment. A smaller private migration
  may use one pull request with clearly separated commit series for those two
  passes.

Publication and progress reconciliation, begun on 2026-07-28 and cumulatively
updated through the current ledger:

- The initial direct program-document publication resolved to
  `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`
  (`docs: add human traceability execution plans`).
- That commit has tree `ea05be8881303557ec9ec8f7951bbef76a4922fc`,
  parent `95065d769f585464b15059423057e151877fdb1a`, and adds only this
  master plan, the execution plan, and the governance/checker child plan:
  2,787 inserted lines across three new Markdown files. It has no associated
  pull request.
- Parent `95065d769f585464b15059423057e151877fdb1a` is the merge commit
  for GitHub PR #45. It published the primary human-understandability principle
  in `AGENTS.md`, the code-writing skill, the canonical code standard, the
  human review guide, and their integrity test. It did not add the Wave 0
  organization/naming sections or checker behavior.
- For `4ec117db1e09e00f86ed8f66cbf8adab1cdeb4a9`, GitHub Actions run
  `30328273160` (**Push on main**) and run `30328273405`
  (**Deploy Web + API**) passed. Run `30328273358`
  (**Run Hetzner Supported Distributed Manifests**) failed. Direct publication
  is therefore verified, but the required default-branch completion workflow
  is not green for that commit.
- GitHub's combined commit status also reports failures for
  `deploy/intact-software-systems/rallar-bb-server`,
  `deploy/intact-software-systems/relic-hunters`, and
  `deploy/intact-software-systems/rallar-server`. This documentation-only
  reconciliation records but does not diagnose those deployment failures.
- Wave 0 Tasks 1 through 5 were implemented and published through
  `55469829af67eabdc692ab4e9823c0e26fabb40b`. Final integration produced
  immutable feature tree `47a885540b60765a1a0c95089902a0371e0a7f2b` and
  feature SHA `a986931c250c2f1fa12daa3e8d44a74669b178ed`. Branch Release
  Gate run `30362667041` attempt 2 passed for that exact feature SHA. Human-
  approved PR #47 merged as
  `4f98f241aefe62c89288e29403ba7f1f23897625`, and **Run Hetzner
  Supported Distributed Manifests** run `30367222275` attempt 1 passed for
  that exact resulting `main` SHA. The governance/checker implementation
  therefore reached `complete`.
- The separate governance evidence ledger has tree
  `94270ad17f7f68eaa9b95529764c23a844514ae9`, feature SHA
  `c4743acd9fc685292f9fa6a7508d0a08afe05fd6`, successful Branch Release
  Gate run `30371906927` attempt 1, and PR #51. It merged as exact `main` SHA
  `7a6c8e0c2cfb3413b4c0fbaaf0af31af2571c015`; **Run Hetzner Supported
  Distributed Manifests** run `30407710853` attempt 1 passed for that exact
  SHA. The governance/checker child is therefore `ledger-published`.
- Browser structure/boundary Tasks 0 through 6 completed at frozen tree
  `a43c05ee5046a2a5fec6c7bc7223dfaec5868365`, feature SHA
  `ca6c907c50d12a5d52a2b54ebf81e81cff2c4a54`, Branch Release Gate
  `30505292166` attempt 1 success, PR #53, resulting `main` SHA
  `a0baa7ed77c9759e9a3c2c3c3c5da4c5ca845960`, and **Run Hetzner Supported
  Distributed Manifests** `30506826362` attempt 1 success for that exact SHA.
- Browser alignment Tasks 7 and 8 completed at frozen tree
  `0061bce118c30759d9a71beb867692dc97c0bf84`, feature SHA
  `ec49e76b95160d2a2d0fb54b140963cd144f3dcd`, Branch Release Gate
  `30513466787` attempt 1 success, PR #54, resulting `main` SHA
  `d807b602ad0b400c5bfc10b8da955093df57f5ce`, and **Run Hetzner Supported
  Distributed Manifests** `30516918807` attempt 1 success for that exact SHA.
  Its final headless Brotli measurement was `191.817383 KiB`, strictly below
  the fixed `<192 KiB` budget.
- Browser evidence ledger PR #55 published frozen ledger tree
  `96f0f763577a18983a9a9f08f87147a9ab154930` from feature SHA
  `7db208ed977fdcad4a1afef8a5d08c3cfdbb862c`. Branch Release Gate run
  `30519129484` attempt 1 passed for that feature SHA. It merged as exact
  `main` SHA `b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`; **Run Hetzner
  Supported Distributed Manifests** run `30520679271` attempt 1 passed for
  that exact SHA. The browser child is therefore `ledger-published`.
- Server structure PR #59 published frozen tree
  `c1ac6a57dad974d04264cbe1fa92313697256712` from feature SHA
  `bec8bea4eb095de9ad3a6b47c18e6799ab811239`. Branch Release Gate run
  `30694693554` attempt 1 passed for that feature SHA. It squash-merged as
  exact `main` SHA `06e0c5ab138c2ab55ac519b2244f727acd42d560`; **Run Hetzner
  Supported Distributed Manifests** run `30697799787` attempt 1 passed for
  that exact SHA. The server structure, traceability QA, and traceability
  hardening implementations are complete.
- Server evidence-ledger PR #66 published frozen tree
  `111995e3a72eb246fd0b8028aada4fbeda65fe69` from feature SHA
  `6e2ea5e4c727f431743e0ad6eab55a0fc9d9af1b`. Branch Release Gate run
  `30778763061` attempt 1 passed for that feature SHA. It merged as exact
  `main` SHA `04b041824073e50a4f1623ca9a71d0d02b770c12`; **Run Hetzner
  Supported Distributed Manifests** run `30780849548` attempt 1 passed for
  that exact SHA. The server structure, traceability QA, and traceability
  hardening work is therefore `ledger-published`.
- API-v1 structure PR #68 published frozen tree
  `8126969737977c901dc56a35b3b523a9209a4fa7` from feature SHA
  `cb9f074db23135de682a19108282b95f71b5e54e`. Branch Release Gate run
  `30815005047` attempt 1 passed for that feature SHA. It squash-merged as
  exact `main` SHA `4d616edc649fe30ebf0fca48db4ab683d9c512e3` with the same
  tree; **Run Hetzner Supported Distributed Manifests** run `30818878869`
  attempt 1 passed for that exact SHA.
- API-v1 code-standard alignment PR #69 published frozen tree
  `620bb455688ee4f927dd662da0fce01a3c0c7bd9` from feature SHA
  `bcabb62072fa82759e21fc14f6e7efedd7adf00f`. Branch Release Gate run
  `30825695539` attempt 2 passed for that feature SHA. It squash-merged as
  exact `main` SHA `cff66107dfa13c47e117d9e1dbcfb8f6ae747ea3` with the same
  tree; **Run Hetzner Supported Distributed Manifests** run `30833235855`
  attempt 1 passed for that exact SHA. The API-v1 implementation is therefore
  `complete`.
- API-v1 evidence-ledger PR #70 published frozen tree
  `8f9502ff3da6a1934e49cbd6d8b6a7508e5e7695` from feature SHA
  `3ff182f65da7360974ad316033e4dad5eeeb8b12`. Branch Release Gate run
  `30861897688` attempt 1 passed for that feature SHA. It merged as exact
  `main` SHA `44d1c9ff74f2d1a837f49c3a6ed696491788cd8c`; **Run Hetzner
  Supported Distributed Manifests** run `30864134072` attempt 1 passed for
  that exact SHA. The API-v1 child is therefore `ledger-published`.

## 1. Why This Is A Program Instead Of One Refactor

The repository contains several different kinds of debt:

1. mechanical naming and formatting debt;
2. physical structure and co-location debt;
3. responsibility and call-stack indirection debt;
4. contract and optionality debt;
5. failure-flow, side-effect, and functional-dataflow debt;
6. public API, OpenAPI, persistence, and compatibility debt.

Those categories do not have the same risk. Renaming a private file and updating
its imports is different from making an optional authoritative field mandatory
or replacing exception flow with `Either`. Combining them in one repository-wide
change would make review unreliable and regressions difficult to diagnose.

The unit of migration is therefore one owned feature flow, not one file and not
the whole repository. A feature flow includes its boundary, contracts,
orchestration, pure decisions, persistence or transport adapters, public exports,
and matching tests.

Each feature migration receives a focused child implementation plan. The child
plan records exact current and target files, public compatibility decisions,
behavior characterization, focused commands, and completion evidence. This
master plan governs the order and rules shared by those child plans.

## 2. Current Navigation Baseline

The planning audit found these high-signal examples:

| Area                                                |               Current shape | Navigation consequence                                                                                   |
| --------------------------------------------------- | --------------------------: | -------------------------------------------------------------------------------------------------------- |
| `packages/shared-server/rallar-system/services`     | 102 direct TypeScript files | Auth, group-state, CRDT, AppInbox, topology, RTC, and WebSocket responsibilities are siblings.           |
| `packages/shared-server/rallar-system/repositories` |  27 direct TypeScript files | Repository contracts, implementations, storage keys, assembly, and exact reads are mixed.                |
| `packages/shared-web/browser`                       |  43 direct TypeScript files | Facades, browser stores, middleware, transport, and feature behavior are mixed.                          |
| `packages/shared-web/browser/rallar-runtime`        |  23 direct TypeScript files | The same capability nouns appear both at browser root and under runtime.                                 |
| `apps/api-v1/src/routes`                            |              13 route files | Large feature routes mix decoding, defaults, authorization, commands, reads, result mapping, and errors. |
| `apps/api-v1/src/services`                          |  17 direct TypeScript files | Factories, auth, middleware, configuration, startup, and services share one layer folder.                |
| `packages/tests/shared-server`                      | 196 direct TypeScript files | Production features and their tests do not have matching navigable paths.                                |
| `packages/shared-test/rallar-bb-test`               |  67 direct TypeScript files | Distributed run, fleet, artifact, browser, and control concerns are mixed.                               |

Using the warning checker's filtered production source set, 215 TypeScript files
are over 400 physical lines, 162 are over 500, and 97 are over 800 in the
2026-07-28 planning baseline. These counts are review inventories, not commands
to split files mechanically or to register every legacy hard-tier file.

Important current hotspots include:

- `packages/shared-server/rallar-system/services/group-state-mutations.ts` at
  more than 4,200 lines;
- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts` at
  more than 1,700 lines while also owning topology and RTC RTT behavior;
- `packages/shared-server/rallar-system/services/group-state-service.ts` at
  more than 1,200 lines;
- `apps/api-v1/src/routes/group-state-routes.ts` at more than 1,200 lines;
- `packages/shared-web/browser/rallar-runtime/rooms.ts` at more than 1,000
  lines;
- `packages/shared-web/browser/api-workflows.ts` at more than 1,000 lines.

The repository already contains useful internal phase boundaries. For example,
group-state mutation processing has a direct `read`, `compute`, `validate`, and
`write` sequence. The first objective is to expose those existing boundaries in
the filesystem before redesigning behavior.

`packages/shared-graph` is a useful relative example: it already uses feature
folders such as `graph`, `mesh`, `tree`, `crdt`, and `repository`, and has far
fewer oversized files. The program should reuse that feature-first principle,
not mechanically copy every folder name.

## 3. Canonical Vocabulary Boundary

### 3.1 Product and browser language

Browser product APIs use these nouns:

- room;
- room member;
- room presence;
- room state;
- room event;
- current room.

New browser-facing filenames, symbols, and documentation use `room`, not
`group`, when describing the product capability.

### 3.2 Authoritative API and server language

Authoritative HTTP, AppInbox, domain service, persistence, event, and snapshot
code uses these nouns:

- group-state;
- group member;
- group presence;
- group-state mutation;
- group-state event;
- group-state snapshot.

Avoid the mixed term `state group` in new code. Use `group-state` for the
authoritative capability and `GroupStateXxx` for its symbols.

### 3.3 The single translation boundary

The target browser boundary is:

```text
packages/shared-web/browser/rooms/room-group-state-translation.ts
```

This module owns pure translations between browser room inputs/views and
authoritative group-state request/response contracts. Its primary exports use
the canonical `toXxx` vocabulary, for example:

```ts
interface ToCreateGroupStateRequestInput {
  readonly roomInput: RallarCreateRoomInput;
  readonly principalId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly requestId: string;
}

function toCreateGroupStateRequest(input: ToCreateGroupStateRequestInput): CreateGroupRequest;

function toRallarRoomSummary(snapshot: GroupSnapshot): RallarRoomSummary;
```

The boundary is one conceptual module. If it exceeds the 400-line review
threshold, it may become a `room-group-state-translation/` folder with one
same-named entry file and responsibility-specific `to-*` modules. Callers still
enter through that single named boundary.

During migration, existing direct `GroupSnapshot` use in the browser is recorded
as compatibility debt. The first room migration preserves the current
`RallarRoomsFacade` return-type compatibility. A child plan that wants to retain
a compatibility alias or re-export must request human approval and state its
removal condition. Product-named public room contracts and changes to the facade
return types require a separate breaking-release plan.

## 4. Target Repository Shape

The package boundaries remain stable. Their internal first-level organization
becomes feature-oriented.

```text
packages/shared/api/
  auth/
  client-state/
  group-state/
  topology/
  admin/

packages/shared-server/rallar-system/
  app-inbox/
  auth/
  client-state/
  crdt/
  group-state/
  rtc-topology/
  topology/
  websocket/
  admin/

packages/shared-web/browser/
  composition/
  auth/
  calls/
  crdt/
  data/
  director/
  media/
  messages/
  people/
  realtime/
  rooms/
  rtc/
  websocket/

packages/shared-test/
  black-box-runner/
    api-v1-state-write/
    artifacts/
    browser/
    providers/
    scenarios/
  rallar-bb-test/
    artifacts/
    browser/
    control/
    distributed-run/
    fleet/
    recipes/

apps/api-v1/src/
  composition/
  auth/
  client-state/
  crdt/
  group-state/
  rtc-topology/
  topology/
  admin/
  database/
  websocket/

packages/tests/
  shared/
    <matching shared feature>/
  shared-web/
    <matching browser feature>/
  shared-server/
    <matching server feature>/
  shared-test/
    <matching test-tool feature>/
```

This is a target vocabulary map, not an instruction to create every directory
up front. A directory is created when its first migrated feature needs it.
Empty architecture scaffolding is not added.

### 4.1 Target group-state server shape

```text
packages/shared-server/rallar-system/group-state/
  group-state-service.ts
  group-state-service-contracts.ts

  inbox/
    group-state-inbox-handler.ts
    group-state-inbox-contracts.ts

  mutation/
    group-mutation-contracts.ts
    read-group-mutation.ts
    compute-group-mutation.ts
    validate-group-mutation.ts
    write-group-state-mutation.ts

  persistence/
    group-state-repository.ts
    group-state-storage-keys.ts
    group-state-runtime-namespaces.ts
    read-exact-group-state-mutation.ts
    read-group-state-authority.ts
    assemble-group-state-snapshot.ts
    group-state-write-descriptors.ts

  presence/
    group-presence-service.ts
    group-presence-summary-work.ts
    reconcile-expired-group-presence.ts

  snapshot/
    group-state-snapshot-read-through-cache.ts
    validate-persisted-group-snapshot.ts
```

The approved
[server structure child](rallar-group-state-server-structure-plan.md) refines
this responsibility skeleton into an exact current/target move map, mirrored
test tree, public and internal compatibility inventory, AppInbox call trace,
and topology/RTC inbox-owner split. Its authorized amendments retain the pending
repair and pre-merge alignment boundaries recorded in the child plan.

`AppGroupInboxService` must not remain the owner of topology configuration and
RTC RTT mutation behavior merely because those messages currently arrive
through the same queue infrastructure. AppInbox supplies infrastructure;
group-state, topology, and RTC topology own their respective decisions.

### 4.2 Target API-v1 group-state shape

```text
apps/api-v1/src/group-state/
  register-group-state-routes.ts
  group-state-read-routes.ts
  group-state-mutation-routes.ts
  group-membership-routes.ts
  group-presence-routes.ts
  to-group-state-command.ts
  to-group-state-response.ts
  group-state-route-errors.ts
```

`registerGroupStateRoutes` is the obvious entry point. It contains route
registration, not domain behavior. Route modules expose the boundary sequence
directly: decode and default, authenticate, translate, submit or read, and map
the response.

### 4.3 Target browser room shape

```text
packages/shared-web/browser/rooms/
  rallar-rooms-facade.ts
  browser-rallar-rooms.ts
  room-group-state-translation.ts
  room-state-store.ts
  room-events.ts
  room-presence.ts
  create-and-join-room.ts
  update-room.ts
```

The current facade/controller/operations forwarding chain is reviewed during
this migration. A public facade is allowed as a real package boundary, but a
wrapper that only forwards every call to another object should be collapsed or
made the actual owner of a boundary decision.

### 4.4 Target API-v1 composition shape

```text
apps/api-v1/src/composition/
  create-rallar-server.ts
  create-default-rallar-server.ts
  create-api-v1-runtime.ts
  create-group-state-runtime.ts
  create-realtime-runtime.ts
  create-admin-runtime.ts
  register-api-v1-routes.ts
  start-api-v1-background-work.ts
```

`createRallarServer(input)` receives required dependencies.
`createDefaultRallarServer()` reads validated application configuration,
constructs the default dependencies, and calls `createRallarServer(input)`.
Defaults, environment reads, and service selection stay visible in this
composition folder.

## 5. Co-location And Ownership Rules

| Artifact                                                              | Owning location                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| OpenAPI request/response schema                                       | `apps/api-v1/resources/api-v1-openapi.yaml`                              |
| Cross-runtime HTTP DTO                                                | `packages/shared/api/<authoritative-feature>/`                           |
| Browser product input/view                                            | `packages/shared-web/browser/<product-feature>/`                         |
| Browser-to-authoritative translation                                  | The named product/authoritative translation boundary                     |
| Command, `Read`, `Computed`, validation issue, and `Written` contract | Beside the use case or service that owns the phase sequence              |
| Persistence record, storage key, exact read, and snapshot assembly    | `<feature>/persistence/`                                                 |
| Explicit-dependency service factory                                   | Beside the concrete service                                              |
| Production-default factory                                            | Application `composition/`                                               |
| Route request-to-command translation                                  | API feature folder beside its routes                                     |
| Route error-to-response translation                                   | API feature `*-route-errors.ts`                                          |
| Private one-use interface                                             | Same file as its behavior                                                |
| Intentionally shared exported contract                                | Named feature contract file, exported through the package boundary       |
| Tests and test support                                                | Mirrored feature path under `packages/tests` or the owning app test tree |

Do not create global `interfaces`, `types`, `translators`, `factories`,
`helpers`, or `utils` directories. Those names identify an implementation
artifact, not an owner.

## 6. File And Symbol Naming Rules

The program adds these rules to the canonical standard before production moves
begin:

- TypeScript filenames use kebab-case, including files whose primary export is
  a class.
- A file's basename matches its primary exported class, function, interface, or
  capability after mechanical Pascal/camel-to-kebab conversion.
- Action modules are verb-first and match the canonical function vocabulary:
  `read-group-mutation.ts`, `compute-group-mutation.ts`,
  `validate-group-mutation.ts`, and `write-group-state-mutation.ts`.
- Route registration functions are descriptive, such as
  `registerGroupStateRoutes`, rather than generic exports named `init`.
- Lifecycle functions may use `init`, `start`, and `stop` only with the owned
  capability in the full name.
- Generic filenames such as `utils.ts`, `types.ts`, `helpers.ts`,
  `contracts.ts`, `runtime.ts`, and `middleware.ts` require a feature noun and
  role, for example `group-state-service-contracts.ts` or
  `api-v1-http-middleware.ts`.
- Historical implementation names such as `task10-*` and `*-correction-17`
  are replaced with the behavior or invariant the test proves when that test
  feature is migrated.
- Established abbreviations such as API, CRDT, HTTP, RTC, SQL, URL, WebSocket,
  and WS are allowed. Local abbreviations such as `svc`, `mgr`, `cfg`, `ctx`,
  `req`, `res`, `grp`, and `proc` are not introduced in public or domain names.
- `mod.ts` remains a package compatibility boundary. Do not add nested barrels
  merely to shorten imports.
- Internal code imports the owning file directly. Public package consumers use
  the intentional package entry point.

Directory review heuristics:

- More than 20 direct production TypeScript files prompts a folder ownership
  review.
- Four or more sibling files with the same meaningful feature prefix prompts a
  feature-folder review.
- A new one-file folder requires a real public or runtime boundary; do not add
  folders for visual symmetry.
- Prefer `feature/subfeature/file.ts` and avoid deeper nesting unless the
  additional level removes a genuine mixed responsibility.
- Every feature folder has one obvious starting file named for the feature's
  public service, facade, or route-registration function.

These are review signals, not reasons for mechanical pass-through modules.

## 7. How Existing Standard Violations Are Migrated

### 7.1 Classify before changing

Every finding in an active feature receives one of these classes:

| Class       | Examples                                                                          | Required treatment                                                    |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Mechanical  | formatting, import groups, kebab-case filename, generic local variable            | Change only in the active feature; format touched files.              |
| Structural  | feature folder, file split, co-location, primary-symbol filename                  | Characterize behavior first; move without semantic changes.           |
| Semantic    | required fields, defaults, function vocabulary, `Either`, purity, state ownership | Separate test-driven change after structural moves are stable.        |
| Contractual | public API, OpenAPI, persisted value, event, queue, snapshot, response            | Separate approved child plan with producer and consumer migration.    |
| Operational | transaction, retry, concurrency, environment/configuration, background lifecycle  | Separate high-risk child plan with integration and performance gates. |

Automated tools may perform mechanical formatting and import updates after a
human has selected the exact feature scope. Automated tools must not decide
whether optionality is meaningful, where a responsibility belongs, whether a
failure is expected, or whether an abstraction should exist.

### 7.2 Use a two-pass feature migration

Large, public, or cross-package features use two independently reviewable pull
requests. Features touching more than approximately 20 files are considered
large unless the child plan explains why the files form one smaller review
unit. Smaller private features may use two clearly separated commit series on
one feature branch and pull request:

1. **Structure pass**
   - add characterization and public-surface tests;
   - move files into the target feature tree;
   - rename files and primary symbols;
   - split oversized files only along existing behavior boundaries;
   - update direct imports and mirrored test locations;
   - preserve behavior and contracts;
   - inspect the diff with rename detection.
2. **Code-standard pass**
   - make defaults visible at boundaries and composition roots;
   - replace optional internal contracts with complete stage contracts;
   - apply `interface` versus `type` rules;
   - make `read`, `compute`, `validate`, and `write` phases explicit;
   - replace expected exceptions with `Either` or validation issues;
   - normalize runtime exceptions at side-effect boundaries;
   - remove pass-through helpers and wrapper-only modules;
   - apply the canonical 40/50/60 general-function review and the file-size
     tiers before extracting code;
   - reduce files, functions, and handlers over their review thresholds only at
     coherent responsibility boundaries;
   - rerun behavior, contract, and integration tests.

Do not hide semantic rewrites inside a rename-only change. Do not postpone all
semantic cleanup indefinitely either: a feature is not marked standard-compliant
until its second pass is complete.

### 7.3 Ratchet new work

While legacy migration proceeds:

- all new files follow the target feature tree and naming rules;
- a touched over-400-line file may not grow without explicit human approval;
- a materially touched over-800-line file or over-60-line function is refactored
  at a coherent boundary or recorded in the repo code-style exception registry;
- a change that materially touches two responsibilities splits them;
- new public optional fields require documented domain absence;
- new production defaults are placed in OpenAPI or typed application
  composition, never in a deep helper;
- an active feature may not add new warnings to its recorded structural and
  code-style baseline;
- unrelated files are not cleaned merely because they are nearby.

This prevents the migration target from moving away while avoiding a giant
repository rewrite.

## 8. Warning-Only Tooling Additions

Extend `scripts/repo-style-check.mjs` through a focused
`scripts/repo-style-check/layout-rules.mjs` module. The checker remains
non-blocking and reports:

- production directories with more than 20 direct TypeScript files;
- flat directories containing at least four files with the same meaningful
  feature prefix;
- mixed PascalCase/camelCase/kebab-case TypeScript filenames;
- generic production filenames lacking a feature noun;
- generic route registration exports named only `init`;
- `mod.ts` files outside approved package boundaries;
- likely mismatch between a filename and its primary exported symbol;
- browser room modules that directly construct authoritative group-state
  requests outside `room-group-state-translation.ts`;
- server group-state modules that introduce the product noun `room` outside an
  established protocol identity or explicit boundary adapter.

The primary-symbol mismatch and room/group-state vocabulary checks start
opt-in because syntax and protocol exceptions can make them noisy. Tests,
fixtures, and mocks remain excluded from the default checker; task-history test
filenames are handled by human review during the mirrored-test migration.
Checker output must explain that folder-size and prefix-cluster findings are
ownership review prompts, not automatic instructions to create folders.

Strict mode remains unavailable until the human separately approves it after:

- a sample of 100 warnings, or every warning when fewer exist, has at most a
  five-percent false-positive rate for the candidate blocking rule;
- all actively migrated features have stable focused checks;
- the repository has no unexplained new-warning growth for three consecutive
  completed feature migrations;
- the human decides which subset, if any, should become blocking.

## 9. Compatibility And Import Migration

File moves must distinguish internal and public paths:

- update private/internal direct imports in the same structure pass;
- preserve package `mod.ts` as the public compatibility surface;
- do not create nested re-export chains for internal convenience;
- allow at most one temporary compatibility re-export hop under the approved
  program policy, with each concrete shim explicitly approved in its child
  plan;
- record the old path, consumers, approval, and removal condition in the child
  plan;
- remove an approved shim after all supported consumers use the intended public
  entry point and the removal has separate compatibility approval;
- if compatibility is not approved, leave the public file in place and migrate
  only its private implementation until a breaking plan is approved.

The completed `plans/rallar-shared-web-modularization-iterations-plan.md`
already established browser public-surface snapshots, bundle checks, and narrow
entry points. This program preserves those results and reorganizes the current
domain implementations; it does not reopen the completed bundle-modularization
work without evidence.

## 10. Program Order

### Wave 0: Governance and measurable baseline

Goal: make the target rules reviewable and the debt visible before moving code.

PR #45 supplies the already-published primary-principle prerequisite. It does
not satisfy any checkbox in this Wave 0 implementation list.

- [x] Add repository-organization and filename sections to the canonical code
      standard.
- [x] Extend the human review guide with feature ownership, matching filename,
      and co-location checks.
- [x] Add warning-only layout checks and fixture tests.
- [x] Record baseline counts for directory density, filename style, generic
      filenames, and files over 400 lines.
- [x] Confirm the checker remains non-blocking and strict mode remains rejected.

The executable baseline measured at
`1b8a3bf18fc67f7a893a6c7d9566497bedda99dc` and published through
`55469829af67eabdc692ab4e9823c0e26fabb40b` records 16 dense directories,
22 conservative prefix clusters across 8 directories, 422 filename-style files
across 90 directories, 15 generic filenames, 11 generic route registrations,
zero unapproved `mod.ts` files, and 215 files over 400 physical lines. The
detailed opt-in inventory is 344 primary-export mismatches, 2 browser-room
boundary findings, and zero server group-state vocabulary findings. The
complete checker exited `0` with known warnings, while strict mode remained
unavailable and exited `1`.

An active feature records its focused layout counts before its structure pass.
The pass may reduce them or leave explained legacy debt unchanged; it may not
add an unexplained warning. Repository totals are context, not a reason to
expand the active feature scope.

### Wave 1: Pilot the complete room/group-state flow

Goal: prove the migration method on the highest-value end-to-end navigation
path.

This wave was initially split into three child plans so each remained
reviewable:

1. browser rooms and the explicit room/group-state translation boundary;
2. authoritative shared-server group-state service, mutation, persistence,
   presence, and AppInbox ownership;
3. API-v1 group-state routes, composition, and mirrored tests.

PR #59's post-publication human review added a fourth QA child between items 2
and 3. The
[server traceability QA plan](rallar-group-state-server-traceability-qa-plan.md)
first strengthens skills, review guidance, test discoverability, review-size
evidence, and independent lineage governance, then applies behavior-neutral
entry/exit, registration-lifetime, immutable transaction-result,
handler-capability, naming, and timing-dispatch corrections. Its two PRs are
published. The
[server traceability hardening plan](rallar-group-state-server-traceability-hardening-plan.md)
adds a fifth child with durable navigation/guidance first and behavior-neutral
protocol, transaction-owner, presence-decision, timing-inventory, semantic-
ratchet, and naming work second. Its PR #64 and PR #65 envelopes are complete,
and PR #66 published the resulting server evidence ledger. The linked
[API-v1 route child](api-v1-group-state-route-structure-plan.md) now describes
the final HTTP boundary needed to complete the pilot.

Acceptance requires that a human can start at `RallarRoomsFacade.create`, find
the one room/group-state translation, continue to the API route and AppInbox,
then follow `read`, `compute`, `validate`, and `write` by matching filenames.

#### 8.1.1 Pilot evaluation approved on 2026-08-04

Verdict: the pilot materially improved human traceability, but the migration
method must be tightened before reuse. The conclusion is based on the final
trees, code-derived traces, warning-only checker output, review records,
compatibility inventories, and green publication envelopes. The pilot did not
capture a controlled before/after human navigation-time sample, so the verdict
is structural and review-based rather than a measured claim about minutes
saved.

The final path is materially easier to locate and follow:

1. Browser room ownership is colocated under `browser/rooms`; the feature entry
   is `browser-rallar-rooms.ts`, and
   `room-group-state-translation.ts` is the one named boundary from room product
   inputs to authoritative group-state inputs.
2. API-v1 registration starts at `registerGroupStateRoutes`, delegates to named
   route-family registrars, and exposes parsing, request-to-command translation,
   AppInbox completion, error translation, and response serialization as named
   owners under `apps/api-v1/src/group-state`.
3. Server queue entry starts at `AppGroupInboxService`, crosses the explicit
   descriptor boundary, and later reaches
   `GroupStateInboxHandler.processGroupStateMutation`. The mutation then follows
   named `read`, `compute`, `validate`, transaction/write, durable-result,
   after-commit observation, wake, and caller-result boundaries.
4. The colocated server `group-state/README.md` separates construction and
   registration from later queue invocation and documents ordinary mutation,
   presence, snapshot/query, event, retry, early-exit, failure, and cleanup
   families.

The representative production trace followed during evaluation was:

```text
RallarRoomsFacade.create
  -> createBrowserRallarRooms
  -> createAndJoinRoom
  -> createAndJoinStateGroup
  -> createAndJoinStateGroupWithInput
  -> toCreateGroupStateRequest
  -> HTTP POST
  -> registerGroupStateRoutes / registerGroupStateMutationRoutes
  -> readGroupStateRouteRequest
  -> toGroupStateCommand
  -> processGroupAppInbox / defaultProcessGroupAppInbox
  -> AppGroupInboxService.processAuthenticatedEntryUntilCompletion
  -> later AppInbox delivery
  -> GroupStateInboxHandler.processGroupStateMutation
  -> read -> compute -> validate -> transaction/write
  -> durable result -> confirmed-commit observation -> wake
  -> toGroupStateResponse
```

The two `createAndJoinStateGroup` hops are the retained positional compatibility
seam discussed below; the rest of the trace crosses named protocol, queue,
transaction, side-effect, and response boundaries. Retry re-enters the server
read/compute/validate path. Inactive presence, authorization/validation errors,
transaction failure, missing durable result, and failed after-commit work are
named early or terminal exits rather than implicit branches in a giant owner.

The physical result supports that trace. The browser room feature now has 17
TypeScript modules and no module above 399 lines; the server group-state feature
has no TypeScript module above 387 lines; and API-v1 group-state has 13
TypeScript modules and no module above 374 lines. The target feature directories
have zero current layout-density, repeated-prefix, generic-filename,
generic-route-registration, and server-vocabulary findings. These are supporting
signals, not proof by themselves.

The warning-only checker remains a guardrail rather than a success score. Its
published repository default baseline was 4,613 findings; the current default
scan reports 4,560. Current layout counts are 15 dense directories, 21 repeated
feature-prefix clusters, 422 filename-style findings, 15 generic filenames, and
10 generic route registrations, compared with the governance baselines of 16,
22, 422, 15, and 11. Focused default scans still report 30 browser-room, 90
server-group-state, and 10 API-v1-group-state findings; construction detail adds
three browser and four server findings. The pilot therefore improved the active
layout and prevented new debt without claiming a repository-wide cleanup or a
warning-free target feature.

The review history also shows the cost. Browser structure PR #53 changed 73
files (`+10,774/-5,773`) and alignment PR #54 changed 24
(`+1,981/-1,260`). Server structure PR #59 changed 301 files
(`+40,935/-25,056`) and required the later PR #61/#62 QA and PR #64/#65
hardening pairs. API structure PR #68 changed 50 files (`+8,067/-3,471`), and
alignment PR #69 changed 16 (`+1,348/-1,088`). Every final implementation
review recorded Critical 0 and Important 0, and the focused, repository,
Branch Release Gate, and resulting-main workflows are green. That evidence
supports behavior preservation, while the follow-up count demonstrates that the
original server review unit was not adequately bounded for human review.

Rules that helped most were:

- feature-first ownership with descriptive filenames and matching primary
  symbols;
- one explicit translation boundary per protocol change;
- separate construction/registration and runtime timelines plus family-level
  code-derived traces;
- named transaction, retry, durable-result, and after-commit ports;
- structure and code-standard alignment in separately reviewable publication
  stages;
- semantic characterization, concurrency, black-box, compatibility, and
  performance evidence before claiming behavior-neutrality;
- direct one-hop compatibility limits with named consumers and removal
  conditions;
- warning-only checks combined with exact-base comparison and human disposition;
- durable colocated navigation for a large feature; and
- the non-circular implementation and later-ledger publication contract.

The pilot also exposed rules and practices that created cost or indirection:

- Treating the 400-line module and 60-line general-function limits as target
  architecture encouraged small modules and occasional pass-through seams. They
  must remain hard review thresholds, while cohesion and direct call paths decide
  the split.
- Exact approved target trees were too brittle. The server work required many
  narrow plan amendments for behavior-neutral private ownership refinements.
- Compatibility preservation sometimes left canonical internal callers routing
  through legacy positional wrappers. Compatibility modules should serve legacy
  imports only; new canonical callers should use the named-input owner directly.
- Exact file, literal, case, and assertion-count ratchets protected large moves
  but can ossify layout. They are supplementary and must be removed or replaced
  by semantic ownership and call-path checks when their ledger removal condition
  is reached.
- PR #59 was too large for fast human review and required two later QA children.
  A structure/alignment split alone is insufficient when one structure PR spans
  several materially different control-flow families.
- Chronological evidence made the child plans very large. Stable rules and
  decisions belong in plans; run-by-run evidence belongs in PR and handoff
  envelopes, with only final immutable facts reconciled into program records.
- The governed performance protocol and its tolerated variance were settled too
  late. Future mutation-path children must freeze the environment, comparison,
  tolerance, no-reroll rule, and failure choices before the candidate is frozen.

Remaining debt is explicit rather than silently treated as complete:

- Browser compatibility remains at the old `rallar-rooms-facade.ts` path and in
  the room workflow exports from `api-workflows.ts`. Their known public/deep
  import consumers and breaking-release removal conditions remain authoritative.
- The browser room feature now meets the durable-navigation threshold introduced
  later in the pilot but has no colocated navigation map. A future browser
  maintenance child should add one without reopening behavior.
- Server direct one-hop compatibility remains at the approved old service,
  mutation, repository, storage-key, presence, and snapshot-validation paths.
  Each must be removed only by the child named in its existing removal condition.
- The API-v1 service compatibility path remains for the later composition wave.
  The temporary API-v1 source/style ratchet was human-authorized for removal
  after PR #70 reached `ledger-published`; the separately reviewed decision now
  satisfies its removal condition. Persistent semantic route, lineage, and
  active-path owners remain.
- The client-state PR C source/style inventory, PR A and PR B exact-tree lineage
  assertions, and fixed test-owner hash have explicit retirement or replacement
  decisions. This evidence-only ledger records those already-published
  decisions verbatim but executes none of the source, test, manifest,
  assertion, hash-removal, or replacement work and does not reschedule or
  report any of it as complete.
- Focused warning-only checks are not finding-free: boundary `unknown` findings,
  several browser positional-input and pass-through findings, and small API route
  handler-size findings still require human disposition. Zero layout findings
  must not be reported as zero human-traceability debt.

Before another child is approved, its plan must apply these migration-method
changes:

1. Capture a before trace and a controlled human navigation-time sample, then
   define family-level target traces and the durable navigation owner before the
   first structure edit.
2. Split review and publication by cohesive control-flow family when the
   predicted structure review exceeds approximately 100 changed files or 10,000
   changed lines; record an explicit stacked-PR decision before implementation.
3. Pre-authorize behavior-neutral private target-tree refinements inside locked
   public, persistence, authority, transaction, and dependency-direction rules.
4. Require canonical internal code to bypass compatibility-only wrappers and
   require every wrapper to name consumers, an owner, and a removal milestone.
5. Prefer semantic ownership, protocol, transaction, and exit-path tests. Give
   every syntax or inventory ratchet an owner and a concrete ledger-time removal
   or replacement decision.
6. Require focused checker output to have an explicit human disposition, not
   merely an exit-zero warning-only result.
7. Fix the correctness and performance acceptance protocol before candidate
   freeze, and keep chronological execution evidence outside the normative plan.

The one recommended Wave 2 child is an **authoritative client-state server
structure child**. It is the safest next feature because it already uses the
same AppInbox and optimistic-concurrency architecture proven by the pilot, has
concentrated ownership hotspots (`client-state-mutations.ts`,
`AppClientInboxService.ts`, `client-state-service.ts`, and
`ClientStateRepository.ts`), and has existing focused concurrency,
idempotency, API, and black-box evidence. It is lower risk than auth
(security/identity), topology or RTC (distributed liveness), CRDT (different
convergence semantics), and admin (broad cross-domain authority).

The linked
[client-state server structure plan](rallar-client-state-server-structure-plan.md)
is bounded to authoritative shared-server client-state entry, mutation,
persistence, AppInbox ownership, mirrored tests, and durable navigation. API-v1
callers are characterized and verified but not reorganized. The human approved
these pilot conclusions at exact blobs
`4172437a6ca3ef6008446a1797582b4e4b9406a9` and
`3dc5495f5ee21b615a44f4e65c92deee8b42a940`; approved the child at exact blob
`71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`; and merged its three
behavior-neutral implementation PRs after their exact gates passed. The
implementation is complete through resulting `main`
`df9ab8d27de17c29b927c9ed9fcce9251ba7e62a`. Evidence-ledger PR #75 then
published feature `2858bf0c2a9b882a82ae4c33abf58d6e0408be8d`, frozen tree
`104478f66bcabbbcf101ea97a80d2a2060cb10ec`, and Branch Release Gate run
`31097790516` attempt 2 success. It merged as exact `main`
`6b75cfc5ec61f81b465be9072b746d24ecdb5f22` with the same tree, and Run
Hetzner Supported Distributed Manifests run `31100952224` attempt 1 succeeded
for that exact SHA. The client-state child is therefore `ledger-published`.

The next bounded Wave 2 child was the
[authoritative auth server structure plan](rallar-auth-server-structure-plan.md), approved at
exact blob `123990bceac9732660e1113101addd5b194d8347`. It remained limited to auth-owned
shared-server mutation, credential, session, persistence, AppInbox, compatibility, test, and
durable-navigation ownership. API-v1 and other authorization consumers were characterized and
verified but not reorganized. Planning PR #76 and implementation PRs #78, #81, and #90 are
complete. Its separately authorized later ledger was published through PR #93.

#### 8.1.2 Auth implementation completion ledger

The completed publication envelopes are:

1. Planning PR #76: approved blob `123990bceac9732660e1113101addd5b194d8347`, feature
   `38a961c4ee184856422b3acf6f0494d04d8d6e5b`, frozen feature tree
   `aa82a21c85d7a6504aaa1a203aaabfe439d90af5`, Branch Release Gate `31103489838` attempt 2
   success, resulting main `61e708708f94328f095f1f1fa5690747bb933476`, tree
   `32fad7c720dcc1eb462f6b486ff64db4f687f67e`, and default workflow `31106485616` attempt 1
   success.
2. PR A #78: feature `5118891effa1b9c856154ecab051c2df1b094145`, frozen feature tree
   `0082575cf0697a170c2125cf856ae07fedfe37e2`, Branch Release Gate `31159741601` attempt 1
   success, resulting main `a90042398448776b0972aaaaa0f5cca762163fde`, tree
   `9a3084c2c78f90f004054924b99b97be67fe72bd`, and default workflow `31163606362` attempt 1
   success.
3. PR B #81: feature `1f7d7b0682c93c7c831fc2a31c0f635829d50734`, frozen feature tree
   `2a5d756b83f44b6b8bbae166e8571f761371af29`, Branch Release Gate `31185044360` attempt 1
   success, resulting main `8152de39faf2d630158143366596d61346e20457` with the same tree,
   and default workflow `31187663870` attempt 1 success.
4. PR C #90: feature `7245a40a1022192885ec3eaabc68d75c68ef61d4`, frozen feature tree
   `f3eb38ab4573198622f766f39af1cef20753e3ae`, Branch Release Gate `31228541734` attempt 1
   success, resulting main `eb0c58c9ffbeb290dafa5cfaba6e5a005b2418b2`, tree
   `0b6520fa7c9f642b252f56a0d009851730769cda`, and default workflow `31241669511` attempt 1
   success.
5. Evidence-ledger PR #93: feature `aeff6435794dd70816789e4794b78e84fdfc89b0`, frozen tree
   `8bdea4402dad08dbd1892f2bd8c95671d615b8ff`, and resulting main
   `c2cb79c020bceee7f67e6fbc364ba96ea0d6a530` with the same tree under the explicitly accepted
   plan-only build-gate exception. Run Hetzner Supported Distributed Manifests `31251480014`
   attempt 1 failed and remains non-gating external evidence for that plan-only publication. It
   is not diagnosed or relabeled.

PR C's resulting tree differs from its frozen feature tree in exactly nine modified paths, with
no additions or deletions. All nine resulting blobs already existed on merge parent
`4192f4fe5d9a735d9dc24791d129e697a247da64`, and no auth PR C path differs. The difference is
accepted concurrent-main base drift, not unexplained PR C mutation. Later auth
diagnostic/snapshot test maintenance does not alter that historical evidence, the runtime, the
final 33 warning rows, or the ratchet policy.

The controlled human navigation sample was waived. No timing, wrong-file count,
compatibility-hop count, unresolved-question count, productivity claim, causal claim, or
statistical claim exists. All 49 original warning rows retain the human-approved disposition and
owner mapping from ignored Task 1 report SHA-256
`804ef9174a91cd33e2d080671657ee3e8d6597c9b65531f1b8c32d93f62dd899`. Final focused evidence
is exactly 33 inherited `boundary.unknown` rows: 13 credential/decoder, 18 persistence, and two
AppInbox/handler. Layout modes are zero and changed-style introduced no new or worsened finding.

All five family traces are complete: login/credential issuance; authenticated AppInbox mutation;
session lifecycle/logout/expiry/revocation; ticket issue/consume; and
authentication/authorization proof/query. Direct one-hop compatibility surfaces retain their
exact consumer owners and removal conditions, while canonical auth bypasses compatibility-only
wrappers. Semantic security, transaction, ownership, routing, compatibility, exit-path, and
durable navigation checks remain primary and permanent. Snapshot/source ratchets remain
supplementary, fail-closed, child-owned evidence retained through PR C; they are eligible for a
separately scoped cleanup only after this later ledger publishes, and this task removes none.

PR B's accepted immutable A-B-B-A records are A1
`ede88c02bfa57b02aa4f5c5ffe45c78f75e39be5d8378a8a55da2ccdd1e3ae14`, B1
`d252ac681262924f21ce32b9e8e19e23712ec1f92cf9b4c21b234e1993c6f339`, B2
`ec2e63eda73d18f726ed13aabcf243027ac68e9ea05a17c681db3eb9541e75c6`, and A2
`afb66ff1ac9f3df9554c992450f4008426f9e1f5d0c14f51f67400055ce91404`. Pooled base is
`631f5d4a0208a537efd36cce5b520371d870d842512643888bbaf4c318ea0ed8`, pooled candidate is
`7bbae106a02f2b2ee89137530c525ce0019cf3098441705f2cbfaf6e2116c8de`, and manifest is
`f8a031cedf7dd2bbbd3997f5695a5f5f6ac92da7a5772e7a848488d3dbda7430`. Comparator log
`9dba8bda5e968ef87cd6f578989faa3c0dcdc1f1b8b24f4fcc11eda3ba55407b` retained exit 1 for four
recognized within-policy movements; child evaluator
`9b1681f20f2ca4e8ae23faa507cba020d1456d9763db484ee5499756c6ba1c80` passed without a
conflict-depth exception. Rejected or superseded evidence remains historical and is not
relabeled.

The auth child is `ledger-published`. Group-topology implementation is closed
through planning PR #95, plan amendments #125/#127/#129/#131, implementation
PRs #103/#151/#155/#209, and the authenticated receipt at exact main
`8ee348e215a3e30d9b4959ce90369aea1b55b620`. The active
[group-topology evidence ledger](rallar-group-topology-evidence-ledger-plan.md)
may reconcile only this program record, the execution record, its own plan, and
the generated registry. It authorizes no production, API-v1, RTC/RTT, or
performance work.

### Wave 2: Remaining authoritative mutation domains

Migrate in this order because they already expose strong filename clusters and
share the AppInbox architecture:

1. client-state;
2. auth;
3. group topology configuration;
4. RTC topology and RTT;
5. CRDT mutation and administration;
6. mutating admin operations.

Each child plan must preserve the existing AppInbox, transaction, retry,
idempotency, outbox, and optimistic-concurrency invariants.

### Wave 3: API-v1 composition and configuration

Separate the current broad `middleware.ts` and `create-rallar-server.ts`
responsibilities into explicit composition units. Introduce required
`createRallarServer(input)` and visible `createDefaultRallarServer()` assembly.
Move operational defaults into validated JSON configuration and retain only the
approved environment-variable allowlist. OpenAPI remains the source of HTTP
request defaults.

This wave must not change API behavior merely to make composition cleaner.
Configuration-source changes receive their own rollout and deployment review.

### Wave 4: Remaining shared-web browser features

Migrate auth, messages, realtime, RTC, calls, media, people, director, data,
CRDT, WebSocket, and browser composition. Preserve the existing public API and
bundle-boundary tests unless a separately approved child plan changes them.

Review every facade/controller pair. Keep a facade when it is a real product or
package boundary; collapse wrappers that only forward calls without owning a
decision, lifecycle, state, translation, or compatibility boundary.

### Wave 5: Test and black-box tooling structure

Mirror production feature folders under `packages/tests`. Move mutation-boundary
analysis implementation into its own folder. Rename task-history tests by the
behavior or invariant they prove.

Split `packages/shared-test/rallar-bb-test` into distributed-run, fleet,
control, artifact, recipe, and browser features. Split
`packages/shared-test/black-box-runner` into scenario, provider, browser,
artifact, and API-v1 state-write evidence features.

Test moves must preserve test discovery and package commands. Avoid changing
test behavior in the same commit as a path-only move.

### Wave 6: Remaining package hotspots

Apply the same method to `packages/shared/cache`, `packages/shared/crdt`,
`packages/shared/services`, AL/ALM, queuebox, persistence, WebRTC, multicast,
RallarAI, Rallar Game, Rallar Match, Rallar Motion, and remaining apps.

The work is prioritized by active change frequency, navigation pain, file size,
and boundary risk rather than alphabetically.

### Wave 7: Broader enforcement decision

Incremental enforcement now blocks only new or worsened branch findings. Review
the final warning inventory, false-positive samples, and remaining approved
exceptions before deciding whether any full-repository mechanical checks may
also become blocking. Semantic checks such as responsibility, purity,
meaningful absence, and decision depth remain human review concerns.

## 11. Child Plan Entry And Exit Contract

Every feature child plan begins with:

- current files and direct-file counts;
- current public exports and import consumers;
- one representative top-to-bottom call trace;
- existing behavior and characterization tests;
- exact current-to-target file map;
- file-size tier and 40/50/60 function review for the touched surface, including
  any existing hard-tier exceptions that the change must remove or renew;
- classification of mechanical, structural, semantic, contractual, and
  operational changes;
- explicit compatibility decisions and retirement conditions;
- focused validation commands selected from the Rallar testing guide.

Every child plan ends with:

- an obvious feature entry file;
- no new unapproved public export or import-path break;
- matching primary symbols and filenames;
- tests mirrored to the feature path;
- no unexplained new checker warnings;
- final file-size tier and 40/50/60 function review for the touched surface;
- every materially touched over-800-line file and over-60-line function either
  refactored at a coherent boundary or recorded with human approval in the repo
  code-style exception registry;
- documented remaining debt for the feature;
- exact passed, failed, unavailable, and skipped validation results;
- updated program progress in this plan or its approved successor ledger.

Feature status values are:

| Status             | Meaning                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `unmapped`         | No current-to-target ownership map exists.                                                      |
| `characterized`    | Public surface and representative behavior are protected by tests.                              |
| `structured`       | Files and tests follow the feature tree without intended behavior changes.                      |
| `standard-aligned` | The feature's touched production code follows the code standard or records approved exceptions. |
| `verified`         | Focused and required broad checks passed on the final feature code.                             |
| `published`        | Draft PR and required remote gates passed for the exact commits.                                |

Do not report a feature complete at `structured`; its known semantic
code-standard debt remains visible until `standard-aligned` and `verified`.

## 12. Progress Measures

Use measures that correspond to human navigation rather than changed-line
volume:

- number of feature folders with an obvious entry file;
- maximum direct TypeScript files in active production folders;
- count of production files over 400 lines;
- count of production files over 500 lines;
- count of production files over 800 lines;
- count of generic production filenames;
- count of mixed-case filename violations;
- count of wrapper-only call-stack hops found and removed through manual review;
- count of direct room/group-state crossings outside the named boundary;
- count of feature trees whose tests mirror production ownership;
- feature status from `unmapped` through `published`;
- sampled time for a human to trace one representative input-to-write flow.

Do not use total lines changed, files moved, or warning count alone as success.
A mechanical split that creates pass-through files can improve those numbers
while making navigation worse.

## 13. Validation Matrix

### Governance and checker changes

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/repo/repo-code-style-integrity.test.ts \
  packages/tests/repo/repo-style-check.test.ts
npm run check:repo-style
```

### Shared contract or package-boundary changes

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

### Browser room changes

```bash
npx vitest run packages/tests/shared-web/rooms/rallar-rooms-facade.test.ts \
  packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-message-channel-compat.test.ts \
  packages/tests/shared-web/rallar-readiness.test.ts
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
```

### Shared-server and API-v1 group-state changes

The child plan selects the exact focused group-state tests. At minimum it
includes group-state service, mutation read, guarded batch, AppInbox authority,
route, public contract, and repository tests, followed by:

```bash
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
```

A mutation-path or concurrency-domain change also requires:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-candidate.json

node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-baseline.json \
  tmp/perf/api-v1-state-write-candidate.json
```

Pure file moves that demonstrably do not alter mutation paths do not need the
performance command, but they still need focused behavior, type, import, public
surface, and API checks selected by their child plan.

### Program completion gate

After all approved child plans have reached their final uncommitted state:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Any change after a successful gate invalidates it. Completion also requires a
current draft pull request, a successful **Branch Release Gate** for the exact
final feature-branch commit, and a successful **Run Hetzner Supported
Distributed Manifests** workflow for the resulting exact default-branch commit.

## 14. First Executable Child Plans

After this master plan is approved, use the
[program execution protocol](repo-human-traceability-program-execution-plan.md)
to write, review, approve, execute, and hand off these child plans in order:

- [x] [Repository human traceability governance and checker](repo-human-traceability-governance-and-checker-plan.md)
  - state: approved at blob
    `8ee56ac27189f9bed751fb6a95992830bda6be60`; implementation `complete` at
    feature SHA `a986931c250c2f1fa12daa3e8d44a74669b178ed`, merged `main`
    SHA `4f98f241aefe62c89288e29403ba7f1f23897625`; separate ledger PR #51
    merged as `7a6c8e0c2cfb3413b4c0fbaaf0af31af2571c015` and reached
    `ledger-published` after workflow run `30407710853` passed;
  - exact code-style wording;
  - warning-only layout rule implementation and fixtures;
  - initial measured baseline.
- [x] [Rallar room/group-state translation boundary](rallar-room-group-state-translation-boundary-plan.md)
  - state: exact Git blob
    `37861202ce25c3cd5832663a5a3f6d7e2e4a0e4e` approved with only recorded
    narrow amendments; structure/boundary frozen tree
    `a43c05ee5046a2a5fec6c7bc7223dfaec5868365`, feature
    `ca6c907c50d12a5d52a2b54ebf81e81cff2c4a54`, Branch Release Gate
    `30505292166` attempt 1 success, PR #53, resulting `main`
    `a0baa7ed77c9759e9a3c2c3c3c5da4c5ca845960`, and default workflow
    `30506826362` attempt 1 success; alignment frozen tree
    `0061bce118c30759d9a71beb867692dc97c0bf84`, feature
    `ec49e76b95160d2a2d0fb54b140963cd144f3dcd`, Branch Release Gate
    `30513466787` attempt 1 success, PR #54, resulting `main`
    `d807b602ad0b400c5bfc10b8da955093df57f5ce`, and default workflow
    `30516918807` attempt 1 success; evidence-ledger tree
    `96f0f763577a18983a9a9f08f87147a9ab154930`, feature
    `7db208ed977fdcad4a1afef8a5d08c3cfdbb862c`, Branch Release Gate
    `30519129484` attempt 1 success, PR #55, resulting `main`
    `b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`, and default workflow
    `30520679271` attempt 1 success; browser child `ledger-published`;
  - browser room target tree;
  - explicit translation functions;
  - facade compatibility decision;
  - shared-web and app consumer validation.
- [x] [Rallar group-state server structure](rallar-group-state-server-structure-plan.md)
  - state: approved at Git blob `1a74159d37f76a459009e99ca5a08f3cd620b1b4` with
    authorized amendments; feature
    `bec8bea4eb095de9ad3a6b47c18e6799ab811239` and tree
    `c1ac6a57dad974d04264cbe1fa92313697256712` passed Branch Release Gate
    `30694693554` attempt 1, PR #59 squash-merged as `main`
    `06e0c5ab138c2ab55ac519b2244f727acd42d560`, and default workflow
    `30697799787` attempt 1 succeeded; later ledger PR #66 merged as
    `04b041824073e50a4f1623ca9a71d0d02b770c12` and reached
    `ledger-published` after workflow `30780849548` attempt 1 succeeded;
  - exact move map for group-state service, mutation, persistence, presence,
    snapshot, and AppInbox files;
  - split of topology and RTC RTT ownership from `AppGroupInboxService`;
  - mirrored shared-server tests;
  - mutation-path verification decision.
- [x] [Rallar group-state server traceability QA](rallar-group-state-server-traceability-qa-plan.md)
  - state: guidance/lineage PR #61 and behavior-neutral runtime PR #62 are
    published; PR #62 feature `b579aa56bc656b12f3717f2b02c0e24de9244357`
    and tree `3a7d80a3a9c522ba4954168be5f380aee04f871b` passed Branch Release Gate
    `30739771277` attempt 1, resulting `main`
    `f124f8c3ac57e5f3a92c47f767f8b7e2b19e6af5`, default workflow
    `30741608017` attempt 1 success;
  - checker behavior, public/persisted contracts, and API-v1 organization stayed
    unchanged.
- [x] [Rallar group-state server traceability hardening](rallar-group-state-server-traceability-hardening-plan.md)
  - state: PR #64 feature `6ce2bcce85f3a03446c847f4b07689c1c0b1e70e`, tree
    `00d475e7d40bed7060567ee391ffe1041fba443a`, Branch Release Gate
    `30748239173` attempt 1, resulting `main`
    `49237d8bb75d2239569aa4e3d43f8b88db799602`, and default workflow
    `30749273740` attempt 1 are complete; PR #65 feature
    `a7e429274a8776b8e1cc842da9c472a12feee224`, tree
    `c1cd8fd529efec6486acb34f0d79e084e33141d0`, Branch Release Gate
    `30755181882` attempt 1, resulting `main`
    `5a6ffd385655af75b28aa22feb5a7103f87862a0`, and default workflow
    `30774354577` attempt 1 are complete;
  - PR A: human-traceability guidance and durable colocated navigation;
  - PR B: behavior-neutral discriminated protocol mapping, named transaction
    writer port, handler-owned presence transaction choice, closed timing
    inventory, semantic ratchets, and internal naming alignment;
  - the separate five-plan server evidence ledger was published through PR #66.
- [x] [API-v1 group-state route structure](api-v1-group-state-route-structure-plan.md)
  - state: approved at Git blob
    `00a8efe0e6124ec9882360c1328045cde781b726` with its recorded amendments;
    structure tree `8126969737977c901dc56a35b3b523a9209a4fa7`, feature
    `cb9f074db23135de682a19108282b95f71b5e54e`, Branch Release Gate
    `30815005047` attempt 1, PR #68, resulting `main`
    `4d616edc649fe30ebf0fca48db4ab683d9c512e3`, and default workflow
    `30818878869` attempt 1 are complete; alignment tree
    `620bb455688ee4f927dd662da0fce01a3c0c7bd9`, feature
    `bcabb62072fa82759e21fc14f6e7efedd7adf00f`, Branch Release Gate
    `30825695539` attempt 2, PR #69, resulting `main`
    `cff66107dfa13c47e117d9e1dbcfb8f6ae747ea3`, and default workflow
    `30833235855` attempt 1 are complete; evidence-ledger tree
    `8f9502ff3da6a1934e49cbd6d8b6a7508e5e7695`, feature
    `3ff182f65da7360974ad316033e4dad5eeeb8b12`, Branch Release Gate
    `30861897688` attempt 1, PR #70, resulting `main`
    `44d1c9ff74f2d1a837f49c3a6ed696491788cd8c`, and default workflow
    `30864134072` attempt 1 success; API-v1 child `ledger-published`;
  - route split and descriptive registration symbols;
  - request defaults and request-to-command translation;
  - API-v1 composition changes needed by group-state only;
  - OpenAPI, route, and black-box compatibility checks.
- [x] [Rallar client-state server structure](rallar-client-state-server-structure-plan.md)
  - state: approved at exact Git blob
    `71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`; planning PR #71 feature
    `73bda0999be39248f486f038cccb06e99be39d1f` / tree
    `930c866e5adab6544f1cf263f5bfd674696f555d`, Branch Release Gate
    `30869481618` attempt 1, resulting `main`
    `39b2b7e6312507addfb4629c9d84ab476e83c362`, and default workflow
    `30871724277` attempt 1 succeeded;
  - PR A #72 feature `1e90c412855ea942a8b678aedde3b1c975efd5e8` / tree
    `e957db303770864fad04e6bb02b98cc03bcdc335`, Branch Release Gate
    `30997710887` attempt 1, resulting `main`
    `2fdba024bb347622727d337eb06fc13d2fe129fc`, and default workflow
    `31008375282` attempt 1 succeeded;
  - PR B #73 feature `2dc7d8226e0b08026d992d72ee104bb9f638ed2a` / tree
    `3d5d4a90f66c290ed0c4c362fc6b200acc3788f3`, Branch Release Gate
    `31069282516` attempt 1, resulting `main`
    `21a807c7d303adbf10e3289468323b1ea6b0b01f`, and default workflow
    `31072851821` attempt 1 succeeded;
  - PR C #74 feature `b57b6797e30139a6e77e669fb2c85291d40d9de7` / tree
    `b61e02f0ddb3f22d4f68948f5c227b49c9bcdcf7`, Branch Release Gate
    `31091742579` attempt 1, resulting `main`
    `df9ab8d27de17c29b927c9ed9fcce9251ba7e62a`, and default workflow
    `31095762444` attempt 1 succeeded;
  - evidence-ledger PR #75 feature
    `2858bf0c2a9b882a82ae4c33abf58d6e0408be8d` / frozen tree
    `104478f66bcabbbcf101ea97a80d2a2060cb10ec`, Branch Release Gate
    `31097790516` attempt 2, resulting `main`
    `6b75cfc5ec61f81b465be9072b746d24ecdb5f22`, and default workflow
    `31100952224` attempt 1 succeeded; child `ledger-published`.
- [x] [Rallar auth server structure](rallar-auth-server-structure-plan.md)
  - state: `ledger-published` through evidence-ledger PR #93;
  - planning PR #76 approved blob
    `123990bceac9732660e1113101addd5b194d8347`, feature
    `38a961c4ee184856422b3acf6f0494d04d8d6e5b` / tree
    `aa82a21c85d7a6504aaa1a203aaabfe439d90af5`, Branch Release Gate
    `31103489838` attempt 2, resulting `main`
    `61e708708f94328f095f1f1fa5690747bb933476` / tree
    `32fad7c720dcc1eb462f6b486ff64db4f687f67e`, and default workflow
    `31106485616` attempt 1 succeeded;
  - PR A #78 feature `5118891effa1b9c856154ecab051c2df1b094145` /
    tree `0082575cf0697a170c2125cf856ae07fedfe37e2`, Branch Release Gate
    `31159741601` attempt 1, resulting `main`
    `a90042398448776b0972aaaaa0f5cca762163fde` / tree
    `9a3084c2c78f90f004054924b99b97be67fe72bd`, and default workflow
    `31163606362` attempt 1 succeeded;
  - PR B #81 feature `1f7d7b0682c93c7c831fc2a31c0f635829d50734` /
    tree `2a5d756b83f44b6b8bbae166e8571f761371af29`, Branch Release Gate
    `31185044360` attempt 1, resulting `main`
    `8152de39faf2d630158143366596d61346e20457` with the same tree, and
    default workflow `31187663870` attempt 1 succeeded;
  - PR C #90 feature `7245a40a1022192885ec3eaabc68d75c68ef61d4` /
    tree `f3eb38ab4573198622f766f39af1cef20753e3ae`, Branch Release Gate
    `31228541734` attempt 1, resulting `main`
    `eb0c58c9ffbeb290dafa5cfaba6e5a005b2418b2` / tree
    `0b6520fa7c9f642b252f56a0d009851730769cda`, and default workflow
    `31241669511` attempt 1 succeeded;
  - scope: authoritative shared-server auth ingress, login, credentials,
    sessions, mutation phases, persistence, codecs, compatibility, mirrored
    tests, security characterization, and durable navigation;
  - API-v1, WebSocket, CRDT, room/topic, admin, and other domain consumers are
    characterized and verified without reorganization.
- [ ] [Rallar group-topology evidence ledger](rallar-group-topology-evidence-ledger-plan.md)
  - state: implementation closed; evidence ledger active from exact main
    `8ee348e215a3e30d9b4959ce90369aea1b55b620`;
  - history: deleted implementation plan is authenticated by
    [its closure receipt](rallar-group-topology-server-structure.closure.json)
    and remains available through Git history;
  - scope: authoritative group-topology config protocol, mutation, persistence,
    AppInbox, query, reconfigure, compatibility, mirrored tests, and durable
    navigation;
  - ledger: records exact planning/PR A-D successes, failures, waivers,
    warning/ratchet dispositions, and the skipped-performance decision without
    changing code or performance evidence;
  - API-v1 organization, RTC topology/RTT, WS delivery, browser consumers,
    CRDT, and admin remain characterized-only or out of scope.

Only after the pilot is `verified` should the program copy its migration method
to client-state, auth, topology, RTC, and CRDT. Adjust the method when the pilot
shows that a rule creates extra indirection or harms traceability.

The governance child does not unlock the browser boundary child until its
implementation is `complete` and its separate evidence-ledger publication is
`ledger-published` under the execution protocol's non-circular evidence
contract.

## 15. Explicit Non-Goals

- Do not move every file before the pilot proves the target structure.
- Do not redesign domain behavior merely because a file is moved.
- Do not preserve every old private import path through re-export shims.
- Do not break public browser facades, package exports, wire contracts, or
  persisted contracts without a separate approved migration.
- Do not create one file per interface, type, helper, or operation when
  co-location remains clearer and the file stays cohesive.
- Do not treat a 400-line threshold as a command to create pass-through files.
- Do not require all legacy debt to be fixed before ordinary product work can
  continue.
- Do not enable global strict style enforcement without a later explicit human
  decision. The approved merge-base gate remains limited to new or worsened
  branch findings.

## 16. Approved Execution Decisions

Human review has approved all master-plan execution choices:

1. A public structural move may use one temporary compatibility re-export hop;
   every concrete shim still requires explicit approval, named consumers, and
   a removal condition.
2. The first browser room migration preserves the current
   `RallarRoomsFacade` return-type compatibility. Product-named public room
   contracts require a separate breaking-release plan.
3. Public, cross-package, or approximately greater-than-20-file migrations use
   two pull requests by default. Smaller private migrations may use one pull
   request with clearly separated structure and code-standard commit series.

The browser child is `ledger-published` through PR #55 and exact resulting
`main` SHA `b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`. The shared-server
implementation is published through PR #59 and exact resulting `main` SHA
`06e0c5ab138c2ab55ac519b2244f727acd42d560`. Its traceability QA
implementation is published through PR #61 and PR #62, ending at exact `main`
`f124f8c3ac57e5f3a92c47f767f8b7e2b19e6af5` with default workflow
`30741608017` attempt 1 success. The traceability hardening child is complete
through PR #64 and PR #65, whose exact resulting-main workflows are
`30749273740` and `30774354577`, both attempt 1 successes. The separate server
evidence ledger was published through PR #66 at feature
`6e2ea5e4c727f431743e0ad6eab55a0fc9d9af1b`, tree
`111995e3a72eb246fd0b8028aada4fbeda65fe69`, resulting `main`
`04b041824073e50a4f1623ca9a71d0d02b770c12`, and default workflow
`30780849548` attempt 1 success. The API-v1 child implementation is complete
through PR #68 and PR #69, ending at exact resulting `main`
`cff66107dfa13c47e117d9e1dbcfb8f6ae747ea3` with default workflow
`30833235855` attempt 1 success. Evidence-ledger PR #70 published feature
`3ff182f65da7360974ad316033e4dad5eeeb8b12` and tree
`8f9502ff3da6a1934e49cbd6d8b6a7508e5e7695`, passed Branch Release Gate
`30861897688` attempt 1, merged as exact `main`
`44d1c9ff74f2d1a837f49c3a6ed696491788cd8c`, and passed default workflow
`30864134072` attempt 1. The API-v1 child is `ledger-published`. The pilot
evaluation conclusions were human-approved at exact master blob
`4172437a6ca3ef6008446a1797582b4e4b9406a9` and execution-plan blob
`3dc5495f5ee21b615a44f4e65c92deee8b42a940`. The
[authoritative client-state server child](rallar-client-state-server-structure-plan.md)
was approved at exact blob `71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`.
Planning PR #71 and implementation PRs #72-#74 are complete through exact
resulting `main` `df9ab8d27de17c29b927c9ed9fcce9251ba7e62a`; default workflow
`31095762444` attempt 1 succeeded. Evidence-ledger PR #75 feature
`2858bf0c2a9b882a82ae4c33abf58d6e0408be8d` and tree
`104478f66bcabbbcf101ea97a80d2a2060cb10ec` passed Branch Release Gate
`31097790516` attempt 2, merged as exact `main`
`6b75cfc5ec61f81b465be9072b746d24ecdb5f22`, and passed default workflow
`31100952224` attempt 1. The client-state child is `ledger-published`. The
[auth server structure child](rallar-auth-server-structure-plan.md) is
`ledger-published` through PR #93 at exact resulting main
`c2cb79c020bceee7f67e6fbc364ba96ea0d6a530`. The
group-topology implementation is closed through exact merge
`44cda16e4633a27d4315dc3a3eb41405651e39c3` and authenticated close-out main
`8ee348e215a3e30d9b4959ce90369aea1b55b620`. The
[group-topology evidence ledger](rallar-group-topology-evidence-ledger-plan.md)
is active but not yet merged, so topology is not yet `ledger-published`. This
planning tree authorizes no production, performance, API-v1, RTC/RTT, or later
Wave 2 work.
