# Follow-Up Plan Docs Review

Date: 2026-06-25

Status: Follow-up triage generated from `plans/**` plus light code spot-checks
for plan status drift.

## Purpose

The plan folder contains several implementation plans, companion plans, and
follow-up plans. Many started as forward-looking documents, but the current
repo has implemented a meaningful amount of that work. This document separates:

- work that still appears unfinished
- work that is implemented but still needs production rollout or adoption
- product boundaries that should stay deferred until a concrete need appears
- plan documents that now look stale and should be closed or refreshed

## Reviewed Plans

- `plans/crdt-improvement-plan.md`
- `plans/rallar-ai-companion-follow-up-plan.md`
- `plans/rallar-ai-product-plan.md`
- `plans/rallar-crdt-black-box-apps-support-plan.md`
- `plans/rallar-crdt-black-box-live-validation-plan.md`
- `plans/rallar-crdt-document-encryption-follow-up-plan.md`
- `plans/rallar-crdt-product-and-implementation-plan.md`
- `plans/rallar-crdt-production-hardening-companion-plan.md`
- `plans/rallar-crdt-sequence-text-follow-up-plan.md`
- `plans/rallar-director-readiness-solo-play-plan.md`
- `plans/rallar-game-product-and-implementation-plan.md`
- `plans/rallar-rtc-connection-product-and-implementation-plan.md`
- `plans/rallar-rtc-topology-tree-mesh-plan.md`
- `plans/rallar-server-hardening.md`
- `plans/rallar-shared-web-modularization-iterations-plan.md`
- `plans/rallar-webrtc-product-safety-and-operations-plan.md`

Spot checks used code/tests only to avoid treating stale checkboxes as
unfinished work.

## Short Answer

Yes, there is unfinished work, but the unfinished work is mostly product
adoption, production operations, and documentation cleanup. The largest V1
implementation plans are no longer in their original "not started" shape.

The most important gap is plan-status hygiene: several documents still read as
implementation plans even though the repo now has the named APIs, tests, and
supporting docs.

## High-Confidence Follow-Ups

### 1. Close Or Refresh Stale Implementation Plans

Priority: P0

Several plan documents should be updated before more implementation starts,
because they can mislead future work.

- `rallar-director-readiness-solo-play-plan.md` has all checklist items
  unchecked, but the repo now contains the named surfaces: readiness helpers,
  `rooms.waitForPresence(...)`, expectation-aware `rtc.waitForRoomLane(...)`,
  typed `not-ready`/`no-targets` send outcomes, Rallar Game authority/egress
  diagnostics, and AR Eye UI diagnostics.
- `crdt-improvement-plan.md` still presents core CRDT hardening as planned
  work, but the repo now has CRDT state sidecars, strict path schemas, causal
  frontiers, quotas, tombstone counts, encryption helpers, and related tests.
- `rallar-server-hardening.md` reads like a proposal, while the focused script
  `test:rallar-server-hardening`, strict-read docs, `/events/page` handling,
  QueueBox key-only pub/sub tests, schema docs tests, and state cache hydration
  tests now exist.
- `rallar-game-product-and-implementation-plan.md` describes Rallar Game
  Authority as a follow-up, but shared, shared-web, shared-server, API-v1, and
  Relic adapter code now contain Rallar Game Authority surfaces.

Recommended action:

1. Add a current status note to each stale plan.
2. Mark implemented checklist items or replace old task lists with an
   "Implemented state and remaining work" section.
3. Link to the current tests/docs that prove the implemented state.
4. Keep any real remaining work in follow-up sections, not in stale unchecked
   tasks.

Acceptance:

- A reader can tell whether a plan is active, implemented, deferred, or stale.
- No implemented API is described as missing.
- Future work is named as follow-up work with an owner area and validation path.

### 2. CRDT Production Rollout And Product Boundaries

Priority: P1

The CRDT product and hardening controls are broadly implemented, but production
rollout work remains.

Remaining work called out by the plans:

- Key custody, key rotation automation, revocation UX, and access-loss recovery
  for encrypted CRDT documents.
- Rich text, cursor-preserving text editing, large ordered-document chunking,
  and rich-text tombstone/compaction policy.
- Deployment-specific metrics backend wiring, SLO dashboards, alerting,
  scheduled integrity checks, retention jobs, audit review flows, and automated
  quarantine policies.
- Destructive tombstone garbage collection and automated retention erasure.
- Product decision for whether strict path ownership should be required by
  default for production CRDT documents.
- Product decision for multi-value register conflict UX.
- App/custom-scope live CRDT support beyond the primary room-scoped path.

Recommended action:

1. Create a production rollout checklist from the hardening runbook.
2. Pick a key-custody model before expanding encrypted document usage.
3. Keep rich text separate from JSON CRDT work until an app requires it.
4. Run or schedule the `live-crdt` black-box profile when live services are
   available.

Acceptance:

- Sensitive CRDT documents have a key ownership, rotation, revocation, and lost
  key story before production use.
- Operators have metrics, alerting, backup/restore, retention, and audit
  workflows outside unit tests.
- Rich text remains explicitly out of scope unless a product owner accepts the
  extra complexity.

### 3. RTC, WebRTC, Calls, And Media Productization

Priority: P1

The room transport layer has moved forward: `rallar.rtc.openRoom(...)`,
`rallar.rtc.waitForRoom(...)`, `rallar.realtime.room<T>(...)`,
`rallar.messages.room<T>(...)`, targeted channels, call compatibility tests,
and topology services exist. The remaining work is product polish and operating
model, not simply "make RTC work."

Remaining work called out by the plans:

- Resolve public API naming questions that still appear in the RTC plan.
- Finalize call invite lifecycle semantics: invite, accept, reject, cancel,
  timeout, missed, ended.
- Add do-not-disturb, block-list integration, invite rate limits, richer roles,
  and moderation workflows.
- Add TURN credential refresh, relay budget/cost hooks, and relay diagnostics.
- Improve deterministic fake WebRTC harness coverage for permission denial,
  ICE recovery, handoff, browser sleep, and backpressure.
- Keep SFU-backed large media rooms, recording, transcription, captions, E2EE,
  simulcast, SVC, and active-speaker stage UX as explicit future boundaries.

Recommended action:

1. Refresh the RTC connection plan with what is already implemented.
2. Promote the unresolved API questions into a short decision record.
3. Implement call-invite product semantics before adding more media features.
4. Treat large audio/video rooms as an SFU/relay integration plan, not an
   extension of tree/mesh data overlays.

Acceptance:

- App authors can choose room transport and call APIs without understanding raw
  peer lanes for common flows.
- Denied, blocked, expired, disconnected, relay-only, and degraded paths are
  distinguishable in diagnostics and tests.
- Media features never start microphone/camera/screen capture implicitly.

### 4. RallarAI Adoption Work

Priority: P2

The main RallarAI V1 work and companion guardrails are marked implemented for
the current package/API slice. The remaining work requires concrete adopters or
production trust decisions.

Remaining work called out by the plans:

- Real WebLLM live evaluation requires an application-supplied browser model
  runtime.
- Framework-specific REST examples should wait for a real adopter choosing
  Express, Hono, Fastify, Deno HTTP, or another framework.
- Production trust model is not decided: result signing, provenance
  verification, and accepted-result storage remain deferred.
- Browser model cache lifecycle UI, model warmup, memory pressure handling, and
  unload UI need an application runtime before they become product work.
- Versioned prompt templates, streaming/progress events, pluggable content
  safety hooks, and multi-peer arbitration remain V1.5/V2 ideas.

Recommended action:

1. Wait for a real app integration before adding framework-specific REST docs.
2. Define a trust model before implementing signing or provenance.
3. Keep deterministic mock evaluation in normal CI and live provider evaluation
   behind explicit gates.

Acceptance:

- AI output remains proposal data until domain code validates and accepts it.
- Browser bundles do not include heavy model runtimes by default.
- Live AI tests stay gated and document their model/runtime requirements.

### 5. Shared-Web Modularization Stewardship

Priority: P2

The modularization plan says iterations 1-9 are implemented, and the repo now
has narrow entry points plus bundle boundary tests. The compatibility facade is
still large, though: `packages/shared-web/browser/rallar.ts` is about 9.9k lines
in this review.

Remaining work:

- Keep extracting behavior when existing domain factories are natural homes.
- Avoid growing `rallar.ts` with new product logic unless it is only
  compatibility composition.
- Keep public API snapshots and browser bundle-boundary checks required for
  shared-web entry point changes.
- Continue migrating app code to narrow surfaces where it reduces coupling, but
  keep Black Box on the full facade as a conformance consumer.

Recommended action:

1. Add a lightweight "rallar.ts size and ownership" note to the modularization
   plan.
2. Require new browser product areas to start in a domain module and export
   through the facade, not start inside the full facade.
3. Keep measuring narrow entry point bundles.

Acceptance:

- `rallar.ts` remains compatibility-oriented.
- Each major browser domain has targeted tests.
- Bundle growth and public API growth stay visible in review.

### 6. Server Hardening Rollout Decisions

Priority: P2

The server hardening proposal's technical items appear largely implemented, but
two decisions remain product/operations work.

Remaining work:

- Decide whether strict state read authorization should remain opt-in or become
  the production default.
- Keep the state-sync outbox and async WS recipient resolution deferred until
  fault-injection proves the current AppInbox plus QueueBox model is
  insufficient.
- Wire QueueBox/runtime observability into the production metrics backend, not
  only tests.

Recommended action:

1. Capture a strict-read rollout decision.
2. Add fault-injection criteria for reopening state-sync outbox work.
3. Document which production metrics sink consumes QueueBox timing/counter
   events.

Acceptance:

- Production docs say whether strict reads are required or optional.
- Outbox work has a trigger condition, not just an indefinite deferral.
- QueueBox no-route, key-load-miss, retry age, and pub/sub drop signals reach
  production observability.

## Lower-Priority Or Deferred Boundaries

These should stay deferred unless a concrete product asks for them:

- Graph CRDT as a productized collaborative graph editor.
- AR/spatial CRDT schemas beyond current validation conventions.
- Document-wide collaborative undo across actors.
- Raw binary/blob payloads inside CRDT updates.
- SFU-backed large media rooms.
- Server-side recording, transcription, captions, E2EE, simulcast, SVC, and
  active-speaker UX.
- AI prompt-management product, model cache UI, and multi-model arbitration.

## Suggested Next Order

1. Plan hygiene: refresh stale statuses for director readiness, CRDT
   improvement, server hardening, and Rallar Game Authority.
2. CRDT production rollout: key custody, metrics/SLOs, retention/audit jobs,
   and live `live-crdt` validation.
3. RTC/WebRTC decision record: public API names, call lifecycle, TURN policy,
   and safety defaults.
4. Server hardening decision: strict read default and observability sink.
5. AI adoption only when a real app picks a browser runtime, REST framework, or
   trust model.

## Validation To Run When These Follow-Ups Are Touched

- CRDT core/hardening:
  `npx vitest run packages/tests/shared/crdt-contracts.test.ts packages/tests/shared/crdt-hardening.test.ts`
- CRDT browser/server:
  `npx vitest run packages/tests/shared-web/rallar-crdt.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts`
- CRDT black-box matrix:
  `npm run test:shared-black-box:matrix:live:preflight` when live gates are available.
- Realtime/game:
  `npx vitest run packages/tests/shared-web/rallar-readiness.test.ts packages/tests/shared-web/rallar-rtc-wait-compat.test.ts packages/tests/shared-web/rallar-room-realtime-channel.test.ts packages/tests/shared-web/rallar-game-match.test.ts`
- Shared-web public surface:
  `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
- Server hardening:
  `npm run test:rallar-server-hardening`
- RallarAI:
  `npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts packages/tests/shared-server/rallar-ai-server.test.ts`
