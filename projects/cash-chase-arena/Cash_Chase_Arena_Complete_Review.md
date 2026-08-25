# Cash Chase Arena — Complete Product and Technical Review

**Review date:** 2026-07-12\
**Repository snapshot:** `9540106`\
**Scope:** All five planning documents in `projects/cash-chase-arena/`, current Rallar public code under `packages/**`, AR Eye Hunter, Relic Hunters, and relevant tests.\
**Change boundary:** Analysis only. No application or package implementation was changed.

**Follow-up resolution:** On July 12, 2026, the five source documents were rewritten from this review. The recommended defaults were applied: unranked browser-director MVP, mandatory controlled migration gate, caught/cashed-out spectator state, initial 240-second/10-credit/60-second cash-out tuning, desktop active play, renderer-neutral direct-Three-led bake-off, post-core AI/CRDT, and manual or separately consented telemetry.

**Engineering-readiness follow-up:** On July 13, 2026, `Cash_Chase_Arena_Engineering_Standards.md` was added and the source documents were tightened for deterministic numeric encoding, protocol/build compatibility, typed errors, cancellation/disposal, diagnostics, browser lifecycle, dependency/asset governance, release/rollback, explicit room/game lifecycle rules, and a non-3D migration feasibility gate before renderer investment.

## Evidence convention

- **Verified** means demonstrated by current repository code, tests, or a command run at the audited commit.
- **Inference** means the conclusion follows from verified facts but has not been measured in a CCA runtime.
- **Recommendation** is the proposed product or engineering decision.
- Performance claims that lack a CCA runtime are explicitly marked **Needs measurement**. Existing game bundles are comparative signals, not CCA measurements.
- Source-document line references in this review refer to the audited `9540106` versions before the follow-up rewrite. Those originals remain available through Git history; the current working-tree documents contain the applied resolutions.

## 1. Executive assessment

### Verdict

**Overall viability: high for an unranked 2–8 player party-game MVP; conditional for a production trust model.** The game has a clear risk/reward loop, a suitable small-room networking model, and unusually strong platform support from Rallar. The documents correctly separate simulation authority, transport, presentation smoothing, local persistence, collaborative documents, and generative proposals.

**The documents audited on July 12 were not implementation-ready as one authoritative specification.** They were detailed, but duplicated responsibilities now provided by Rallar, disagreed on MVP content, locked a renderer without a measured comparison, used “star topology” differently from current Rallar, and required host migration without specifying or currently having a complete migration orchestrator. The July 12–13 follow-ups resolve the documentary contradictions; migration and performance remain implementation evidence gates.

### Five most important findings

1. **Current Rallar is materially ahead of the May/June documents.** Rallar Game already provides lane presets, host/backup election, director appointment policy, typed envelopes, epoch/sequence rejection, reliable and realtime routing, diagnostics, sync requests, and browser- and server-authority adapters. CCA should compose those APIs, not recreate `HostCapability`, `HostLease`, election, lane, or envelope infrastructure in `cash-chase-core`.
2. **“Star topology” is not currently a director-centered physical star.** Rallar's `star` planner connects every active session to every other session in `RtcTopologyPlanner.computeStarNextHops` (`packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts`). Rallar Game still routes inputs specifically to the director (`packages/shared-web/game/match.ts`), so authority traffic is super-peer-shaped while connectivity is full-mesh-shaped. The documents must either accept this for 2–8 players or define a new generic Rallar director-star topology.
3. **Host migration is the largest Rallar/game gap.** Rallar exposes a replication lane, backup candidate, recovery state, stale-director detection, sync requests, and stale-epoch rejection, but it does not orchestrate replication, resignation/failover, reappointment, state promotion, and resume. The full-stack director test explicitly verifies stale state “without auto-election” (`tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts:357`).
4. **The renderer stack is over-locked.** Rallar intentionally does not render 3D, so one renderer is justified. React is justified for the DOM shell because it is the established repository UI runtime. Three.js is a reasonable smallest renderer candidate, but React Three Fiber, Drei, postprocessing, and a physics engine are not justified for MVP. Direct imperative Three.js behind a renderer adapter better preserves the stated simulation/presentation boundary and minimizes dependencies. A measured bake-off remains required because Three.js is not currently installed in this repository.
5. **The product scope needs reconciliation before implementation.** The product specifies three missions while the prompt pack implements five; migration is a success metric and milestone but absent from the MVP done definition; AI appears in the core setup flow despite deterministic-first and fastest-loading goals; mobile is “responsive” but not playable; accessibility, audio, browser support, performance, and telemetry collection lack acceptance criteria.

### Strongest parts of the concept

- The survival/cash-out decision creates an understandable risk curve.
- Fixed gameplay capsules and cosmetic-only identities protect fairness and simplify networking.
- Deterministic fallback content prevents AI from becoming availability or correctness authority.
- Rallar Game, Motion, Data, CRDT, and AI are assigned to broadly correct problem classes.
- A two-browser Rallar vertical slice before art investment is the right risk order.
- Original-IP constraints are explicit and should remain release gates.

### Product vision, audience, originality, and replayability

The “instant social chase game” vision is coherent, but the target audience is not defined beyond browser users and party-game behavior. **Recommendation:** design the MVP for small invited groups on desktop who want a 3–6 minute round with little onboarding; validate age/tone, competitive intensity, session length, and whether spectating after catch remains enjoyable. The intended player experience should be: enter quickly, understand the immediate risk, make one meaningful movement/cash-out decision every few seconds, recover clearly from network trouble, and reach a rematch without returning through setup friction.

The mechanics of tag, survival, score pressure, and cash-out are general enough to support original IP, but “neon athletes in a televised-feeling arena” still needs an independent naming, silhouette, costume, audio, UI, and marketing review. Originality must be judged from the assembled presentation, not only from prohibited names.

Replayability should come first from player interaction, arena seeds, the three mission timings, Sentinel pressure, and the cash-out risk curve—not AI or progression. The existing second-round metric is a good test, but the MVP also needs one-click rematch, seed rotation, and enough viable routes that a dominant hiding/cash-out pattern does not solve the game.

### Most serious risks

| Rank | Risk                                           | Assessment                                                                                                                            |
| ---: | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | Browser-director loss and incomplete migration | High probability in real play; high match-impact; platform support is partial.                                                        |
|    2 | Authority/trust mismatch                       | Browser-hosted results are explicitly `room-trusted`, not `server-validated`; unsuitable for ranked rewards without a product change. |
|    3 | Unproven fun/economy                           | Passive survival may dominate missions; round length, score rates, catch behavior, and cash-out availability are not specified.       |
|    4 | Startup and runtime performance                | “Fastest-loading” has no budget; existing renderer artifacts show large 3D chunks.                                                    |
|    5 | Scope dilution                                 | AI, CRDT, modular characters, migration, and deployment are mixed into one MVP sequence despite different risk/value profiles.        |

### Recommended minimum stack

- Existing Rallar browser/server packages, especially Rallar Rooms, Messages, Realtime, Game, Match, Motion, Data, AI, diagnostics, and black-box tooling.
- TypeScript and existing npm workspaces/Vite build tooling.
- React/ReactDOM for lobby, HUD, menus, settings, errors, and accessibility surfaces only.
- Direct, lazy-loaded Three.js for the 3D renderer **after** a measured renderer gate; no R3F or Drei initially.
- Browser-native Pointer Lock, Keyboard, Gamepad (later), Web Audio, IndexedDB via Rallar Data, and Worker APIs.
- Pure TypeScript deterministic simulation and simple capsule/AABB or swept collision; no physics engine for MVP.

## 2. Document inventory and authority

| Document                                              | Intended role                                          | Strong content                                                             | Problems / authority recommendation                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cash_Chase_Arena_Product_Owner_Document.md`          | Product vision and MVP outcomes                        | Core loop, original IP, authority boundaries, success metrics              | Highest product authority, but lacks audience, economy, platform, accessibility, performance, telemetry, and trust decisions. Keep as product source after reconciliation.                                                                  |
| `Cash_Chase_Arena_Implementation_Plan.md`             | High-level build order and technical boundaries        | Correct Rallar Data/Motion/CRDT/AI placement; deterministic-first sequence | Older than later stack plan; migration is milestone 19 but absent from done definition; names R3F without evidence. Replace with a plan generated from the reconciled spec.                                                                 |
| `Cash_Chase_Arena_Rallar_React_Three_Plans.md`        | Stack, architecture, public interfaces, iteration plan | Best runtime separation and testing outline                                | Claims precedence only over the earlier implementation plan (`:15`), not the prompt pack; “locked” stack decisions are not first-principles decisions; duplicates current Rallar Game surfaces. Use as technical background, not authority. |
| `Cash_Chase_Arena_Characters_Controls_Camera_Plan.md` | Character, input, movement, camera, asset detail       | Strong fairness, animation, camera, and visual-QA boundaries               | Too detailed before game-feel validation; locks R3F; incomplete accessibility/gamepad/mobile/audio requirements; contains payload naming inconsistency. Retain domain design after renderer-neutral edits.                                  |
| `Cash_Chase_Arena_Codex_Prompt_Pack.md`               | Incremental implementation prompts                     | Useful milestone-sized task framing and validation reminders               | Oldest technical assumptions remain executable; asks CCA to duplicate Rallar Game; expands mission scope; each prompt can create architecture drift. Retire until regenerated from approved specifications.                                 |

### Proposed precedence after this review

1. Approved product-owner decisions in section 12.
2. A reconciled product specification derived from section 8.
3. A reconciled architecture specification derived from section 7.
4. A new implementation plan derived from section 10.
5. Domain references such as the renderer-neutral character/control/camera plan.
6. The existing prompt pack only as historical input.

## 3. Contradiction and ambiguity register

| ID  | Conflict or ambiguity                                                                                                  | Evidence                                                                                                                                                                                                                                                                                                | Resolution and trade-off                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Document precedence is incomplete.                                                                                     | The June stack plan overrides the earlier implementation plan only (`Cash_Chase_Arena_Rallar_React_Three_Plans.md:15`); the June 8 character plan says it “locks” another layer (`Cash_Chase_Arena_Characters_Controls_Camera_Plan.md:6,13`); the May prompt pack remains executable.                   | **Recommendation:** Treat all five as inputs and replace them with one approved product spec, one architecture spec, and one plan. This costs documentation work but prevents prompt-driven drift.                       |
| C2  | “Fastest-loading” conflicts with an unmeasured multi-framework renderer stack.                                         | Product goal at `Product_Owner_Document.md:10`; React + Three + R3F + Drei at `Rallar_React_Three_Plans.md:21-22,73-83`.                                                                                                                                                                                | Keep React for DOM, test direct Three.js, lazy-load 3D after lobby. Reject R3F/Drei until measured need.                                                                                                                 |
| C3  | Babylon is dismissed because of prior preference, not evidence.                                                        | `Rallar_React_Three_Plans.md:117-119`.                                                                                                                                                                                                                                                                  | Run a small renderer bake-off. Recommend direct Three.js as the minimum candidate; compare against modular Babylon imports using identical scene requirements.                                                           |
| C4  | The documents call the RTC graph a host-centered star, but current Rallar `star` is full connectivity.                 | `Product_Owner_Document.md:30,53-54`; current planner at `rallar-rtc-topology-service.ts:578-586`.                                                                                                                                                                                                      | For MVP, call it **director-routed authority over Rallar room RTC**, not physical star. At 2–8 players, measure first. If connection count is a problem, add generic `director-star` support to Rallar, not CCA netcode. |
| C5  | CCA is asked to recreate Rallar Game host types and election.                                                          | Proposed exports `scoreHostCapability` and `electDirectorCandidate` at `Rallar_React_Three_Plans.md:407,429-430`; prompt creates `HostCapability`/`HostLease` at `Codex_Prompt_Pack.md:58,74`. Current Rallar types/election are at `packages/shared-web/game/types.ts:119-169` and `election.ts:9-95`. | Reuse Rallar Game. CCA supplies only capability readings and optional scoring weights. Game-specific code must not create a second lease or election protocol.                                                           |
| C6  | MVP mission count is three in the product and five in implementation prompt 14.                                        | `Product_Owner_Document.md:37`; `Codex_Prompt_Pack.md:178`; milestone gate again says three at `Rallar_React_Three_Plans.md:757`.                                                                                                                                                                       | MVP has exactly three: disable gate, open cash-out, double reward zone. Rescue and forced movement remain post-MVP experiments.                                                                                          |
| C7  | Migration is required but not in the MVP done definition.                                                              | Success metric `Product_Owner_Document.md:88`; milestone `Implementation_Plan.md:113`; migration prompt `Codex_Prompt_Pack.md:210`; done definition `Implementation_Plan.md:117-129` omits it.                                                                                                          | Product owner must choose: make pause/re-elect/sync a launch gate, or remove the 10-second MVP metric. Recommendation: it is required before external playtests longer than one round.                                   |
| C8  | Rallar detects stale authority but does not currently auto-migrate.                                                    | Recovery state exists at `packages/shared-web/game/types.ts:73-79`; stale sets recovering at `match.ts:984-1013`; full-stack test says no auto-election at `full-stack-director-orchestration.spec.ts:357`.                                                                                             | Implement the missing generic migration orchestration in Rallar Game, with CCA providing serializable replication state and deterministic restore hooks.                                                                 |
| C9  | AI is described as part of every setup flow but is scheduled after the playable loop and cannot be cached server-side. | Core loop `Product_Owner_Document.md:44`; deterministic-first `Rallar_React_Three_Plans.md:388-394`; no proposal cache `Implementation_Plan.md:38-42`.                                                                                                                                                  | Deterministic layout/deck is the default. AI is asynchronous, deadline-bounded, optional variation after core gameplay is proven. It cannot block lobby-to-match.                                                        |
| C10 | “Generates or retrieves” has no permitted durable CCA source.                                                          | `Product_Owner_Document.md:44`; fallback catalogs cannot be server app data at `Implementation_Plan.md:40`.                                                                                                                                                                                             | Ship deterministic fallback recipes in the pure CCA package. “Retrieve” means package content or an ephemeral accepted proposal, not a CCA server store.                                                                 |
| C11 | Replication is declared as a lane and runtime action, but its activation and contract are undefined.                   | `Implementation_Plan.md:18,91`; prompt 17 at `Codex_Prompt_Pack.md:210`.                                                                                                                                                                                                                                | Define one versioned `MigrationCheckpoint`, critical-event journal rules, cadence, size budget, acceptance/ack, and promotion algorithm before coding migration.                                                         |
| C12 | Player and ordering identity may be duplicated in both app payload and Rallar envelope.                                | `PlayerControlInput` contains `playerId`, `seq`, `sentAtEpochMs` at `Characters_Controls_Camera_Plan.md:362-375`; Rallar Game envelope already contains sender, sequence, time, epoch at `packages/shared-web/game/types.ts:194-204`.                                                                   | Use envelope `senderId`, `seq`, `sentAtEpochMs`, and `directorEpoch` as transport identity/order. Payload holds input values plus optional client simulation tick. Never trust a payload `playerId`.                     |
| C13 | Cosmetic snapshot field alternates between ID and full loadout.                                                        | ID at `Characters_Controls_Camera_Plan.md:54-68,114`; full `cosmeticLoadout` at `:378-389`; sample metadata returns to ID at `:405-415`.                                                                                                                                                                | Snapshots carry `cosmeticPresetId` (or a compact validated cosmetic revision), not arbitrary loadout data on every snapshot. Reliable match-start/player-profile messages distribute the validated visual definition.    |
| C14 | Browser-director authority is treated as production authority while anti-cheat is deferred.                            | `Product_Owner_Document.md:18,53-54`; stack plan `:24,34`. Rallar distinguishes room-trusted and server-validated results at `packages/shared/rallar-match/types.ts:89-127`.                                                                                                                            | Browser director is acceptable only for ephemeral, unranked, disclosed sessions. Ranked progression or rewards require current Rallar server authority.                                                                  |
| C15 | Success metrics require collection, while server playtest reports and summaries are forbidden.                         | Metrics `Product_Owner_Document.md:85-90`; persistence prohibition `Implementation_Plan.md:36-37`.                                                                                                                                                                                                      | Define consented export or a separate aggregated telemetry policy. Until approved, metrics are manually collected from bounded local Rallar Data/debug artifacts and cannot be claimed as production analytics.          |
| C16 | Mobile is responsive but intentionally lacks playable controls.                                                        | `Rallar_React_Three_Plans.md:768,783`; `Characters_Controls_Camera_Plan.md:188,620`.                                                                                                                                                                                                                    | Explicitly support desktop gameplay and responsive mobile lobby/spectating only for MVP, with a clear unsupported-control message. Do not imply mobile play support.                                                     |
| C17 | Audio is a setting/cue, not a designed subsystem.                                                                      | Audio setting `Product_Owner_Document.md:66`; threat cue `Characters_Controls_Camera_Plan.md:301`; no audio acceptance section.                                                                                                                                                                         | Add a native Web Audio plan: unlock gesture, buses, voice cap, threat and mission cues, reduced intensity, mute, teardown, and fallbacks. No audio library initially.                                                    |
| C18 | Accessibility is named but not specified.                                                                              | Rallar Data settings mention accessibility at `Implementation_Plan.md:66`; reduced motion appears at `Rallar_React_Three_Plans.md:748`.                                                                                                                                                                 | Add remapping, focus handling, color-independent cues, contrast, HUD scale, reduced motion/intensity, screen-reader lobby/status text, and no audio-only gameplay information.                                           |
| C19 | The game has no performance or browser gate despite a performance-led vision.                                          | Only qualitative browser performance at `Characters_Controls_Camera_Plan.md:165,539`; Chromium-only configs at `apps/rallar-black-box/playwright.config.ts:30-44` and `apps/relic-hunters-v1/playwright.config.ts:24-38`.                                                                               | Adopt section 8 budgets and a Chromium/Firefox/WebKit plus manual Safari matrix before external MVP.                                                                                                                     |
| C20 | Rallar AI integration shape is underspecified.                                                                         | Browser AI is a separate `createRallarBrowserAi` facade (`packages/shared-web/browser/rallar-ai.ts`); server AI is `createRallarServerAi` (`packages/shared-server/rallar-ai/rallar-ai-server.ts`).                                                                                                     | Name the concrete surface in each flow. Production content proposals run server-side; browser AI remains local creator/debug-only and lazy-loaded.                                                                       |

## 4. Requirements traceability matrix

| Material requirement                        | Sources                                          | Phase             | Clarity               | Rallar capability                                           | Gap / unresolved decision                     | Disposition                                                             |
| ------------------------------------------- | ------------------------------------------------ | ----------------- | --------------------- | ----------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Original browser-native chase/cash-out game | Product `:5-10`                                  | MVP               | Medium                | Outside Rallar                                              | Audience, session length, economy             | Keep; specify in section 8.                                             |
| Original IP                                 | Product `:7,17`; stack `:764`                    | MVP               | High                  | Outside                                                     | Legal/art review process                      | Keep as release gate.                                                   |
| 2–8 private room lobby/invite               | Product `:27`; done `Implementation_Plan.md:118` | MVP               | High                  | Rooms, auth, people, presence                               | Invite-link UX                                | Compose `rallar.rooms`; no custom lobby backend.                        |
| Automatic host election                     | Product `:28`; prompt `:74`                      | MVP               | High but stale design | Rallar Game election and appointment                        | Capability weights; trust policy              | Reuse Rallar Game; do not duplicate types.                              |
| Director-routed WebRTC traffic              | Product `:29-31,53-54`                           | MVP               | Medium                | Realtime lanes, room helpers, Director Relay                | Physical topology semantics                   | Keep traffic model; rename topology claim.                              |
| Reliable events/fallback                    | Product `:31`; implementation `:87-92`           | MVP               | Medium                | `rallar.messages.room`, Director Relay                      | Per-message fallback rules                    | Define a protocol routing table.                                        |
| Transport readiness/backpressure            | Prompt `:90,98`; stack `:47`                     | MVP               | High                  | Room realtime status/wait, lane health, queue presets       | Acceptance thresholds                         | Use Rallar Game diagnostics and explicit lane expectations.             |
| Browser director simulation                 | Product `:36,54`                                 | MVP               | Medium                | Rallar Game browser match                                   | Trust, worker placement, migration            | Accept for unranked MVP only.                                           |
| Server authority option                     | Stack `:144-148` calls it future                 | Production option | Stale                 | Current Rallar Authority browser/server adapters            | Product trust decision                        | Treat as current alternative, not future platform work.                 |
| Host migration under 10s                    | Product `:88`; prompt `:210`                     | MVP decision      | Low                   | Partial recovery primitives                                 | Orchestrator/checkpoint contract              | Required experiment and owner decision.                                 |
| Deterministic simulation                    | Stack `:23,188-193`                              | MVP               | Medium                | Outside Rallar                                              | Determinism definition, worker, numeric model | Pure package with fixed-step tests.                                     |
| Input protocol                              | Character `:362-376`                             | MVP               | Medium                | Rallar envelope + input lane                                | Duplicated identity/order                     | Remove duplicate player/transport fields.                               |
| Snapshot protocol                           | Stack `:433-441`; character `:378-418`           | MVP               | Medium                | Rallar snapshot lane + Motion                               | Payload budget, delta/full policy             | Full compact snapshots first; measure before delta encoding.            |
| Motion smoothing/prediction correction      | Product `:70-73`                                 | MVP               | High                  | Rallar Motion fully supplies toolkit                        | CCA sample mapping/tuning                     | Compose, do not reimplement.                                            |
| Procedural arena/fallback                   | Product `:35,38`                                 | MVP               | Medium                | Outside Rallar; Rallar AI proposal contracts optional       | Reachability validator; content location      | Deterministic package fixtures first.                                   |
| Three mission templates                     | Product `:37`                                    | MVP               | High                  | Outside Rallar; routed via Rallar Game                      | Concrete timing/reward rules                  | Keep exactly three for MVP.                                             |
| Sentinel patrol/chase/tag                   | Product `:36,47`                                 | MVP               | Medium                | Outside                                                     | Navigation/LOS/tuning                         | Deterministic simple state machine and coarse spatial queries.          |
| Score and cash-out                          | Product `:5,46-51`                               | MVP               | Low                   | Rallar Match standings/results can represent outcome        | Rates, windows, catch/elimination/reentry     | Owner must approve economy spec.                                        |
| Cosmetic-only runner                        | Product `:20,34,56-61`                           | MVP               | High                  | Rallar Data stores local selection; Game carries ID         | Preset distribution                           | Keep fixed capsule and reliable preset ID.                              |
| Keyboard/mouse controls                     | Character `:184-255`                             | MVP               | Medium                | Outside                                                     | Remapping, focus, pointer lock errors         | Keep, add accessibility acceptance.                                     |
| Third-person camera/threat assist           | Character `:257-320`                             | MVP               | Medium                | Outside; Motion supplies target pose                        | Occlusion algorithm/tuning                    | Renderer-owned, local only.                                             |
| 3D renderer                                 | Stack `:73-85`                                   | MVP               | Prematurely locked    | Outside Rallar                                              | Renderer choice and budget                    | Direct Three candidate, measured gate.                                  |
| GLB/glTF assets                             | Character `:140-167`                             | Later             | High                  | Outside                                                     | Asset budgets/tooling                         | Defer until procedural MVP is fun.                                      |
| Audio                                       | Product `:66`; character `:301`                  | MVP               | Low                   | Outside                                                     | Complete audio design                         | Native Web Audio, procedural/limited assets.                            |
| Local settings/debug persistence            | Product `:33,63-68`                              | MVP               | High                  | Rallar Data                                                 | Store schemas, retention                      | Use Rallar Data only; bounded and validated.                            |
| CRDT creator/review documents               | Product `:75-78`                                 | Post-MVP          | High                  | Rallar CRDT                                                 | No validated MVP use case                     | Remove from MVP and initial bundle/UX.                                  |
| AI layouts/missions/cosmetics               | Product `:80-83`                                 | Post-core         | Medium                | Rallar AI contracts/providers/lifecycle                     | Cost, latency, content policy                 | Optional server-side proposal path with hard fallback deadline.         |
| Diagnostics/debug overlay                   | Prompt `:218`                                    | MVP               | High                  | Rallar Game/RTC/WS/Motion diagnostics                       | CCA simulation/perf metrics                   | Keep hidden-by-default operator overlay.                                |
| Playtest success metrics                    | Product `:85-90`                                 | MVP               | Low                   | Local Rallar Data/debug can collect; aggregation not solved | Consent/retention/export                      | Decide telemetry policy before claiming metrics.                        |
| Browser support                             | Implied browser-native                           | MVP               | Low                   | Rallar has Chromium E2E evidence                            | Firefox/Safari/mobile behavior                | Adopt explicit support matrix and gates.                                |
| Accessibility                               | Implementation `:66`; stack `:748`               | MVP               | Low                   | Rallar Data can persist preferences                         | Functional requirements                       | Add concrete criteria in section 8.                                     |
| Security/secrets                            | Prompt `:19,234`                                 | MVP               | Medium                | Rallar auth, server AI, ICE config                          | abuse/rate limits, host trust                 | Keep secrets server-side; add threat model and limits.                  |
| No server CCA persistence                   | Product `:19,68`; implementation `:22-42`        | MVP               | High                  | Rallar Server can run ephemeral services                    | Telemetry/result expectations                 | Keep for unranked MVP; reconsider for production analytics/progression. |
| Deployment/HTTPS/WSS/TURN                   | Prompt `:234`                                    | MVP               | Medium                | Existing Rallar server/env/ICE                              | CCA staging SLO/runbook                       | Require staging preflight and TURN-path tests.                          |

## 5. Rallar capability map

### Current public evidence

The aggregate browser contract in `packages/shared-web/browser/rallar-facade-contract.ts`
exposes connection/session, Data, CRDT, auth, rooms, people, director, typed
messages, targeted channels, RTC status/recovery, WS status, realtime JSON and
binary lanes, media, and diagnostics. Room-bound `realtime<T>()` and
`message<T>()` handles are owned by `browser/rooms/rallar-room-contracts.ts` and
constructed by `browser/rooms/room-session.ts`. Room realtime results and their
explicit `sent`, `partial`, `not-ready`, `no-targets`, and `failed` outcomes are
owned by `browser/rallar-realtime-facade.ts` and
`browser/realtime/browser-room-realtime-runtime.ts`.

Rallar Game is not merely a transport preset:

- Stable lane roles and flow-control policies exist at `packages/shared-web/game/lanes.ts:7-103`.
- Host capability, deterministic host/backup election, lease concepts, phases, egress, recovery, envelope sequence/epoch guards, and diagnostics are public at `packages/shared-web/game/types.ts:34-397`.
- The match handle provides start/stop, diagnostics, capability reporting, election, appointment, readiness, input, presence, intent, snapshot, event, and sync operations at `types.ts:407-490`.
- Inputs target only the fresh director; snapshots go to the room realtime channel; reliable intents/events/sync use Director Relay at `packages/shared-web/game/match.ts:577-720`.
- `createRallarBrowserMatch` in `packages/shared-web/game/match-support.ts` adds participants, standings, and a room-trusted result boundary.
- Current server authority is public through `installRallarGameAuthorityServer` in `packages/shared-server/game/install-rallar-game-authority-server.ts` and the browser client through `createRallarGameAuthorityClient` in `packages/shared-web/game/rallar-game-authority-client.ts`. Server-validated result creation lives in `packages/shared-server/game/match-result.ts`.

### Classification by subsystem

| Game subsystem                                       | Classification                                | Current Rallar evidence                                                                                                                                                                                                                                                                            | CCA responsibility / gap                                                                    |
| ---------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Authentication and restored session                  | **Fully provided**                            | `RallarFacade.auth` and `session()` are composed by `browser/rallar-runtime/composition/browser-facade-assembly.ts`; AR Eye consumes the canonical browser facade in `apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts`.                                                           | Login/register UI, player-facing errors, and session-expiry UX.                             |
| Rooms, membership, governance, invites, event replay | **Fully provided**                            | `rallar.rooms`; `createAndSwitch`, `session`, and `waitForPresence` are owned by `browser-rallar-rooms.ts`.                                                                                                                                                                                        | Room naming/filtering, ready state payload, invite-link route.                              |
| Scoped identity                                      | **Fully provided**                            | Room APIs accept `GroupRef`; `RallarRoomSession` retains `roomRef` in `browser/rooms/rallar-room-contracts.ts`.                                                                                                                                                                                    | Use `roomRef` rather than bare IDs when scope matters.                                      |
| People and presence                                  | **Fully provided**                            | `browser/rallar-people-facade.ts` owns the public contract and bounded presence waits remain in Rooms.                                                                                                                                                                                             | Derive lobby roster/readiness; do not create a second presence service.                     |
| WebSocket/RTC signaling and ICE                      | **Fully provided**                            | `browser/rallar-rtc-facade.ts` and `browser/rallar-ws-facade.ts` own status, waits, diagnostics, reconnect, and ICE restart contracts.                                                                                                                                                             | Configure Rallar/TURN and surface failure states. No raw transports in CCA.                 |
| Low-latency JSON/binary lanes                        | **Fully provided**                            | `browser/rallar-realtime-facade.ts` owns realtime and room send/status/wait contracts; feature runtimes under `browser/realtime/` implement them.                                                                                                                                                  | Define compact app payloads and rates.                                                      |
| Typed reliable messages and RTC→WS fallback          | **Fully provided**                            | `rallar.messages.room<T>`; the typed message contract is owned by `rallar-message-contracts.ts`, with behavior covered by `rallar-message-channel.test.ts`.                                                                                                                                        | Define topic/type IDs and validation. Do not build a custom channel manager.                |
| Game lane roles and backpressure                     | **Fully provided**                            | Unordered replace-by-key input/snapshot, ordered intent/replication, drop-old metrics at `game/lanes.ts:24-103`.                                                                                                                                                                                   | Tune queue budgets only after measurement.                                                  |
| Host/backup election                                 | **Provided; requires composition**            | Capability model at `game/types.ts:119-169`; deterministic election at `game/election.ts:9-95`; tests at `rallar-game-election.test.ts:8-94`.                                                                                                                                                      | Read device/RTT/FPS signals and optionally supply scoring weights.                          |
| Director appointment/heartbeat/relay                 | **Provided; requires composition**            | `browser/rallar-director-facade.ts` owns the public contract, `browser/director/` owns epoch-bearing relay behavior, and `game/rallar-game-director-appointment-runtime.ts` owns game appointment policy.                                                                                          | Decide when lobby is startable and expose user-facing recovery state.                       |
| Browser-director game runtime transport              | **Provided; requires composition**            | `createRallarGameMatch` and handle at `game/match.ts:67-145`, `game/types.ts:448-483`.                                                                                                                                                                                                             | Pure simulation, payload validators, snapshots, match phases, content.                      |
| Server-authority game transport                      | **Provided; requires composition**            | Shared authority envelopes, browser authority client, server installer, and tests in `packages/tests/shared*/rallar-game-authority*.test.ts`.                                                                                                                                                      | Server simulation service and operational capacity if this authority model is chosen.       |
| Authority trust labeling and standings               | **Provided; requires composition**            | `local`, `room-trusted`, and `server-validated` types at `packages/shared/rallar-match/types.ts:89-127`.                                                                                                                                                                                           | Define score rows and never present room-trusted scores as cheat-resistant.                 |
| Full authoritative simulation                        | **Outside Rallar by design**                  | Rallar transports commands/snapshots/events but does not know CCA rules.                                                                                                                                                                                                                           | Fixed-step movement, collision, missions, scoring, Sentinels, cash-out.                     |
| Snapshot interpolation and prediction correction     | **Fully provided as a toolkit**               | `RallarMotion` buffer, adaptive delay, correction blender, kinematics, send gate, interpolation, dead reckoning, discontinuity, and quantization at `packages/shared/rallar-motion/facade.ts:26-43`.                                                                                               | Map accepted CCA entities to samples and tune with measured jitter/game feel.               |
| Browser-local latest-value persistence               | **Fully provided**                            | Rallar Data scopes, TTL, durability, hydration, schema migration, validation, sync, CRUD, flush, and usage at `rallar-data.ts:18-134`.                                                                                                                                                             | Define bounded CCA store schemas and migrations; keep out of match authority.               |
| Collaborative authored documents                     | **Fully provided for the stated later use**   | Rallar CRDT local/room/custom scope, transport, persistence, encryption, operations, sync, health at `rallar-crdt.ts:61-176`.                                                                                                                                                                      | No MVP use until a real creator/review feature exists.                                      |
| AI proposal contracts/governance                     | **Fully provided as a platform**              | Shared schema, hashing, validation, provider policy, diagnostics, lifecycle, dedupe, replay, mock/evaluation exports at `packages/shared/rallar-ai/mod.ts`; browser facade at `packages/shared-web/browser/rallar-ai.ts`; server facade at `packages/shared-server/rallar-ai/rallar-ai-server.ts`. | CCA schemas, prompts, domain validators, content policy, deadlines, deterministic fallback. |
| Director migration and replicated promotion          | **Partially provided**                        | Backup candidate and replication lane exist; recovery becomes `recovering` on stale director; no auto-election test.                                                                                                                                                                               | Missing generic orchestrator plus CCA checkpoint/restore contract. Largest platform gap.    |
| Director-centered physical RTC star                  | **Partially provided / semantic mismatch**    | Rallar supports configurable `star/tree/mesh`, but `RtcTopologyPlanner.computeStarNextHops` currently maps every peer to all peers in `packages/shared-server/rallar-system/topology/planning/rtc-topology-planner.ts`.                                                                            | Accept full connectivity for small MVP or add a generic director-star topology to Rallar.   |
| Anti-cheat and browser attestation                   | **Outside current Rallar game guarantee**     | Trust types explicitly distinguish room-trusted and server-validated.                                                                                                                                                                                                                              | Server authority for trusted outcomes; input validation/rate limits regardless.             |
| CCA telemetry analytics                              | **Partially provided**                        | Transport/game diagnostics and local Data exist; no approved CCA aggregation/retention path.                                                                                                                                                                                                       | Consent, redaction, aggregation, export, and retention policy.                              |
| Multiplayer test infrastructure                      | **Fully provided as reusable infrastructure** | `packages/shared-test` recipes/providers/artifacts; three-browser RTC and director Playwright suites.                                                                                                                                                                                              | Add CCA recipes/visible-flow tests and reuse artifacts, not a CCA-only harness.             |

### Verified test and bundle evidence

The current focused command is:

```sh
npx vitest run \
  packages/tests/shared-web/rallar-game-election.test.ts \
  packages/tests/shared-web/rallar-game-lanes.test.ts \
  packages/tests/shared-web/rallar-game-envelopes.test.ts \
  packages/tests/shared-web/rallar-game-match.test.ts \
  packages/tests/shared/rallar-motion.test.ts \
  packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-message-channel.test.ts \
  packages/tests/shared-web/rallar-data.test.ts \
  packages/tests/shared-web/rallar-crdt.test.ts \
  packages/tests/shared/rallar-ai-contracts.test.ts \
  packages/tests/shared-web/rallar-game-authority-client.test.ts \
  packages/tests/shared-server/rallar-game-authority-server.test.ts
```

Result: **12 files passed, 137 tests passed**.

The existing bundle measurement command also passed as a reporting run:

```sh
npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles
```

Current Brotli signals are 160.1 KiB for the full browser facade, 6.4 KiB for
Rallar Data, and 15.7 KiB for Rallar CRDT. Historical isolated measurements for
Rallar Game, Rallar Motion, and browser Rallar AI are not treated as current
incremental costs; CCA must measure its own composed application bundle.

### Largest Rallar gaps for CCA

1. Automated browser-director checkpoint replication, failover, promotion, and resume.
2. A true director-centered star topology if full peer connectivity proves too costly.
3. A high-rate server-authority RTC path if production later requires both server trust and RTC-first snapshots; current authority helpers primarily use server WS with optional peer-assisted repair.
4. Product analytics are not a Rallar gap in transport, but CCA has no approved aggregation/retention contract.

## 6. External dependency gap analysis

### Decision rule

Use Rallar for every capability it owns. For capabilities outside Rallar, prefer browser APIs when they are sufficient; otherwise choose one narrow dependency and keep it behind an app-owned adapter. No external dependency may own match authority, networking, persistence, cross-tab sync, game state, or platform diagnostics.

| Candidate / required capability                                 | What Rallar provides                                                                                                              | Precise gap and browser-native option                                                                                                                                                   | Smallest acceptable choice                                                   | Runtime/bundle cost                                                                                                                                                    | Maintenance/integration cost                                                                                 | Decision and rationale                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript + Vite** — compile, module graph, dev/build        | Rallar is source/platform code, not a build tool.                                                                                 | Native modules do not provide TS compilation, HMR, optimized production bundling, or established workspace scripts.                                                                     | Existing TypeScript and Vite 8 (`package.json:138-152`).                     | Build-time only except generated runtime helpers; no new dependency.                                                                                                   | Already standardized in repo.                                                                                | **Accept.** No new framework is introduced.                                                                                                                       |
| **React/ReactDOM** — lobby/HUD/menu UI                          | Rallar exposes state and subscriptions, not DOM rendering/focus/component lifecycle.                                              | Native DOM is capable but would require an app-local UI framework worth of lifecycle/form/error/focus code.                                                                             | Existing React/ReactDOM 19.                                                  | Existing Relic artifact signal: React chunk 189,637 bytes minified / 58,969 gzip; CCA must measure its own split. Runtime cost is low if limited to low-frequency UI.  | Existing repo expertise and test patterns; risk is putting simulation state into React.                      | **Accept for DOM only.** Keep simulation/render loop outside React and avoid per-frame React state.                                                               |
| **Three.js** — 3D scene, camera, meshes, materials, GLB loading | Rallar supplies poses/state, not rendering.                                                                                       | Raw WebGL2 can render but building a scene graph, camera, material, culling, resource lifecycle, and glTF loader is a separate engine project.                                          | Direct modular `three` imports plus its GLTF loader only when assets arrive. | **Needs measurement.** New runtime dependency; lazy renderer chunk budget in section 8.                                                                                | Requires an imperative renderer adapter and lifecycle discipline; avoids another React renderer abstraction. | **Conditionally accept as recommended renderer.** It is the smallest plausible 3D gap-filler; prove in the renderer gate.                                         |
| **React Three Fiber** — React/Three binding                     | Neither Rallar nor React needs to own the render loop.                                                                            | A React component can mount a canvas and create/dispose an imperative renderer directly. No capability gap remains after Three.                                                         | None.                                                                        | Adds runtime, reconciler work, and bundle; exact cost unmeasured.                                                                                                      | Couples scene graph to React and makes high-frequency ownership easier to blur.                              | **Reject for MVP.** Convenience is not a Rallar or browser gap.                                                                                                   |
| **Drei** — scene helpers                                        | No renderer helpers in Rallar.                                                                                                    | MVP needs only a small camera rig, primitives, asset loader, and diagnostics; these exist in Three or small app code.                                                                   | None initially.                                                              | Additional dependency/tree-shaking uncertainty.                                                                                                                        | Helper behavior and upgrade coupling.                                                                        | **Reject for MVP.** Add individual functionality only after a measured need.                                                                                      |
| **React postprocessing package** — bloom/effects                | Rallar has no visual effects.                                                                                                     | The MVP can use readable emissive/basic materials without postprocessing.                                                                                                               | None initially; renderer-native pass later if proven.                        | GPU fill-rate and startup shader cost as well as bundle cost.                                                                                                          | Visual regression/performance matrix.                                                                        | **Reject for MVP.** Game readability and frame budget come first.                                                                                                 |
| **Babylon.js** — alternative 3D engine                          | Rallar has no renderer.                                                                                                           | Browser-native WebGL is insufficient at reasonable scope; Babylon fills the same gap as Three.                                                                                          | Modular `@babylonjs/core` and loader if chosen.                              | Existing Relic artifact signal: Babylon chunk 3,042,461 bytes minified / 678,845 gzip. This is not an equal CCA scene and therefore **needs comparative measurement**. | Strong existing repo examples, but broader engine surface and larger observed chunk.                         | **Do not choose by default.** Include in the time-boxed bake-off because reuse may offset size; accept only if measured outcome beats direct Three on total risk. |
| **Rapier or another physics engine** — collision/dynamics       | Rallar does not simulate physics.                                                                                                 | Pure deterministic capsule, bounds, obstacle, dash, and vault math is sufficient for described MVP.                                                                                     | Pure TypeScript geometry in CCA package.                                     | Physics WASM/runtime would add material startup/bundle/memory cost.                                                                                                    | Cross-runtime determinism, serialization, and migration complexity.                                          | **Reject for MVP.** Reconsider only after a proven collision feature gap.                                                                                         |
| **Zustand/Redux/other state framework**                         | Rallar exposes subscriptions; Rallar Data owns persisted latest-value state.                                                      | React local state plus explicit runtime stores/services covers UI. Simulation already has its own model.                                                                                | None.                                                                        | Avoided runtime and duplicate state copies.                                                                                                                            | Avoided ownership ambiguity.                                                                                 | **Reject.** State authority must remain explicit.                                                                                                                 |
| **Socket.IO/Colyseus/custom WebSocket/WebRTC**                  | Rallar fully provides rooms, presence, signaling, RTC, WS, typed messages, lanes, backpressure, Game, authority, and diagnostics. | No capability gap for the chosen model.                                                                                                                                                 | None.                                                                        | Would duplicate transport and increase bundle/connections.                                                                                                             | Split lifecycle, protocol, diagnostics, and failure handling.                                                | **Reject categorically.** Fill genuine generic gaps inside Rallar packages.                                                                                       |
| **External persistence/database client**                        | Browser Rallar Data covers approved local stores; Rallar Server owns infrastructure persistence.                                  | MVP explicitly forbids server CCA data. Native localStorage/IndexedDB would duplicate Rallar Data.                                                                                      | None.                                                                        | Avoided runtime/storage migration cost.                                                                                                                                | Avoided conflicting cache and sync semantics.                                                                | **Reject.** Revisit only with an approved post-MVP data product.                                                                                                  |
| **Howler/audio framework** — music/SFX                          | Rallar does not synthesize or play audio.                                                                                         | Web Audio provides gesture unlock, gains, oscillators, buffers, scheduling, and voice limits; AR Eye already demonstrates it at `apps/ar-eye-hunter-v1/src/game/arenaAudio.ts:221-275`. | Browser Web Audio API.                                                       | No dependency; audio assets still have transfer/decode costs.                                                                                                          | App owns unlock, teardown, Safari fallback, mixing, and tests.                                               | **Reject audio library initially.** Accept native Web Audio because it fills the gap directly.                                                                    |
| **glTF Transform** — asset optimization                         | Rallar does not author/optimize 3D assets.                                                                                        | Browser runtime should not perform offline prune/dedupe/compression.                                                                                                                    | glTF Transform CLI as a later dev-only tool.                                 | No runtime cost; CI/tool install cost only.                                                                                                                            | Versioned asset pipeline and reproducibility work.                                                           | **Accept later, dev-only**, after GLB assets become a real milestone.                                                                                             |
| **Blender/DCC** — source asset authoring                        | Outside Rallar and browser runtime.                                                                                               | Procedural geometry cannot produce all later character animation assets.                                                                                                                | Team-selected DCC; export only GLB/glTF.                                     | No runtime dependency; human/tooling cost.                                                                                                                             | Asset conventions, licensing, reproducible export checklist.                                                 | **Accept later as production tooling**, not application architecture.                                                                                             |
| **GLB/glTF 2.0** — shipped asset format                         | Rallar transports game state, not model assets.                                                                                   | A standard runtime asset format is required after procedural MVP.                                                                                                                       | GLB/glTF loaded by the chosen renderer.                                      | Network, decode, GPU memory; budgets required.                                                                                                                         | Manifest/scale/rig/material validation.                                                                      | **Accept as format, not framework.** Defer asset-heavy use.                                                                                                       |
| **Zod/validation framework** — app payload validation           | Rallar validates platform envelopes; Rallar AI includes a supported JSON-schema subset.                                           | CCA still needs strict domain validation for layouts, missions, checkpoints, and cosmetics.                                                                                             | Pure narrow validators/type guards in the CCA package.                       | No new runtime; app validators have small code cost.                                                                                                                   | Manual validators require disciplined tests.                                                                 | **Reject external validator for MVP.** Reconsider only if schema complexity demonstrably dominates.                                                               |
| **Browser WebLLM** — client-side AI                             | Rallar AI can host browser providers, but production proposal generation can run through Rallar Server.                           | No MVP need for local model execution; it harms startup, memory, battery, and browser coverage.                                                                                         | Server-side Rallar AI provider with deterministic fallback.                  | Avoids model download/GPU memory in game client.                                                                                                                       | Server provider operations and cost controls remain.                                                         | **Reject browser AI from MVP game bundle.** Keep creator/debug use optional and lazy.                                                                             |

### Minimum dependency conclusion

The defensible MVP runtime dependency set is **Rallar + React/ReactDOM + one renderer**. The recommended renderer candidate is direct Three.js, but it is accepted only after the gate measures startup transfer, first rendered frame, steady frame time, memory, scene ergonomics, and disposal against modular Babylon. R3F, Drei, postprocessing, physics, state, networking, persistence, audio, and browser-AI dependencies are rejected.

## 7. Reconciled target architecture

### Package and app boundaries

```text
packages/cash-chase-arena/       pure product rules and serializable contracts
  protocol/                      app payloads, versions, validation
  simulation/                    fixed-step rules, movement, collision, Sentinels
  missions/                      exactly three MVP templates and scheduler
  arena/                         deterministic recipes, generator, validator
  migration/                     CCA checkpoint schema and restore rules
  presentation-contracts/        renderer-neutral animation/camera cues

apps/cash-chase-arena/           browser consumer
  rallar/                        composition of public Rallar APIs only
  runtime/                       main-thread orchestration and worker bridge
  worker/                        director simulation/local prediction worker
  ui/                            React lobby, HUD, menus, errors, accessibility
  renderer/                      renderer adapter and direct Three implementation
  audio/                         native Web Audio presentation

packages/shared*/                generic Rallar product surfaces
  Rallar Game migration          only if implemented generically
  director-star topology         only if measurement proves it necessary
```

**Recommendation:** Prefer `packages/cash-chase-arena` over the generic `packages/cash-chase-core` name to mirror `packages/relic-hunters` and make the reusable product boundary explicit. The package must not import React, Three, browser globals, or Rallar runtime code. It may define payload types consumed by the Rallar adapter.

### Runtime boundaries

1. **CCA simulation** owns authoritative match state, ticks, rules, collision, missions, scoring, Sentinel decisions, catch/cash-out, checkpoints, and deterministic snapshots.
2. **Rallar Match adapter** owns room/session binding, Rallar Game handle, authority state, capability report, routing, envelope acceptance, readiness, diagnostics, and recovery orchestration. It must not duplicate Rallar Game election, epoch, sequence, or lane logic.
3. **Motion presenter** owns Rallar Motion tracks for received entities, correction blending, adaptive delay, discontinuities, and presentation diagnostics. It does not mutate simulation.
4. **Renderer adapter** owns canvas, scene objects, cameras, resources, animation presentation, effects, and frame sampling. React mounts it but does not reconcile per-frame entity transforms.
5. **React UI** renders low-rate snapshots of lobby/match/diagnostic state and owns forms, focus, menus, HUD, settings, and errors.
6. **Rallar Data adapter** owns validated local settings/loadout/room-recents/debug stores. No simulation code may read it inside a tick.
7. **Rallar AI adapter** owns server proposal requests/lifecycle; CCA validators alone decide acceptance.

### Authority and state table

| State                                                         | Authoritative owner                                                                            | Transport/storage                                             | Consumers                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Auth/session, room membership, presence, director appointment | Rallar                                                                                         | Rallar server/facade                                          | Lobby, Rallar Game adapter, diagnostics      |
| Input sample                                                  | Originating client until validated                                                             | Rallar Game input envelope; short-lived RTC                   | Director simulation only                     |
| Match truth                                                   | Browser-director simulation for approved MVP; server simulation if production authority chosen | Memory; versioned migration checkpoint to backup only         | Snapshot builder, result builder             |
| Match snapshot/event                                          | Fresh authority epoch                                                                          | Rallar Game snapshot/event paths                              | Motion presenter, HUD, audio, diagnostics    |
| Render pose                                                   | Rallar Motion estimate                                                                         | Memory only                                                   | Renderer/camera/animation                    |
| Local prediction                                              | Client prediction worker/model                                                                 | Memory only                                                   | Renderer; reconciled against authority       |
| Settings/loadout selection                                    | Local player                                                                                   | Browser Rallar Data                                           | UI/input/renderer; never authoritative rules |
| Accepted cosmetic preset ID                                   | Match authority after validation                                                               | Reliable match/profile event, then snapshots by compact ID    | Renderer                                     |
| AI output                                                     | Proposal envelope only                                                                         | Ephemeral Rallar AI flow; optional bounded local debug replay | Deterministic validator, operator UI         |
| CRDT authored content                                         | CRDT document until committed                                                                  | Rallar CRDT, post-MVP                                         | Creator/review UI; no active match consumer  |
| Match result                                                  | Room-trusted browser director or server-validated server                                       | Ephemeral MVP object unless data policy changes               | Results UI/optional manual export            |

### End-to-end flows

#### Lobby and match start

1. Restore/authenticate through `rallar.auth`, start Rallar, and create/join with `rooms.createAndSwitch` or `rooms.enter/session` using `roomRef`.
2. Observe room/presence and exchange ready/capability state through Rallar Game/typed room messages.
3. `RallarGameMatch.reportCapability()` and `election()` choose host and backup; elected eligible session calls `appointIfElected()`. CCA does not create another lease.
4. Authority selects a deterministic arena/deck immediately. Optional AI generation may race in the background under a hard deadline; only a valid proposal can replace fallback before commit.
5. Authority sends a reliable versioned setup commit containing match ID, seed/layout, mission deck, protocol version, tick/rate configuration, and cosmetic preset manifest hash.
6. All clients validate/build and acknowledge ready. Rallar Game waits for exact/bounded lane readiness. On timeout, show actionable missing-peer status; the host may retry, remove an unavailable player, or cancel.
7. Authority sends reliable start epoch/tick. The simulation begins only from this committed state.

#### Active match

1. Client samples controls at render/input cadence but sends compact latest input at 20 Hz through `sendInput`; envelope sender/seq/time/epoch is authoritative transport metadata.
2. Director worker consumes validated inputs at a 30 Hz fixed step; missing input repeats only bounded held state and never repeats edge-triggered actions.
3. Director publishes compact full snapshots initially at 12 Hz and reliable state-changing events through Rallar Game. Do not implement delta snapshots until payload/bandwidth measurement proves a need.
4. Clients reject wrong match/epoch/sequence through Rallar Game, push accepted entity samples into Rallar Motion using receiver-observed time, and reconcile local prediction.
5. HUD/audio consume semantic presentation events, not raw packets. Renderer samples Motion each animation frame.

#### Reconnect and late join

1. Rallar surfaces WS/RTC state and retry/reconnect diagnostics.
2. Active match pauses local actions if authority is stale; UI shows reconnect/recovering state.
3. Late/rejoining client requests reliable sync. Authority sends setup commit plus current full snapshot/event revision; client validates before resuming.
4. A reconnecting old director cannot publish after a higher appointment epoch; Rallar Game stale-epoch guards remain the transport gate.

#### Host migration

1. Director sends a versioned full checkpoint to the elected backup at a measured cadence and after critical events. Backup acknowledges the latest accepted tick/revision.
2. Peers detect stale appointment through Rallar, enter paused recovery, and stop accepting new gameplay outcomes.
3. Deterministic Rallar Game election chooses the eligible replacement. The replacement appoints through Rallar, increments authority epoch, promotes the last acknowledged checkpoint, and requests peer state only if the checkpoint is missing.
4. New director sends a reliable recovery commit and full snapshot. Clients discard older epochs, reset Motion discontinuities, and resume on a shared future tick.
5. If no valid checkpoint/backup exists within 10 seconds, end the round as interrupted rather than inventing state.

This flow is a **design requirement**, not current proven Rallar behavior.

#### Match end

1. Authority finalizes standings from authoritative rows and produces a Rallar Match result with the correct trust label.
2. Results UI displays the trust/disclosure appropriate to browser-director hosting.
3. MVP retains no server CCA result. Consented local debug export may include redacted transport/performance data, not credentials or private AI prompts.

## 8. Reconciled MVP specification

### Product statement

CCA MVP is an original-IP, desktop-browser, unranked multiplayer chase-survival party game for 2–8 players. A disclosed elected browser director owns ephemeral match truth. Players accumulate unbanked credits while active, take movement risks to complete three time-bounded missions, and choose when to cash out. A caught player loses unbanked credits and leaves active play for the round; a cashed-out player banks score and spectates. The round ends on its configured timer or when no active runners remain.

The caught/spectator rule above is the cleanest reconciliation of the current documents but still requires product-owner approval; the documents currently say only that caught players lose unbanked score.

### Must-have scope

#### Join and readiness

- Restore or create a Rallar session.
- Create or join a private Rallar room using an invite link/code.
- Show roster, ready state, connection state, and peer-host disclosure.
- Elect host and backup through Rallar Game and appoint only through Rallar Director APIs.
- Provide clear unsupported-browser, auth, room, ICE/TURN, RTC, and readiness errors.

#### Match

- Deterministic fixed-step simulation with versioned initial state and reproducible seed.
- Fixed capsule for all runners; keyboard/mouse camera-relative movement, sprint, dash, contextual vault, and interact.
- Third-person soft-follow/orbit camera with obstruction handling and non-coercive threat cues.
- Host-validated movement/action limits, collision, Sentinel detection/chase/tag, missions, score, catch, and cash-out.
- Exactly three mission templates:
  1. disable a Sentinel gate;
  2. open a temporary cash-out window/station;
  3. activate a double-reward zone.
- Deterministic fallback arena and mission deck always available without AI or remote content.
- Compact full snapshots, reliable critical events, late-join/reconnect sync, and Rallar Motion presentation.
- End-of-round standings labeled as room-trusted when browser-directed.

#### Presentation and UX

- Procedural arena and neon capsule/mannequin runners; no GLB dependency for first playable MVP.
- DOM HUD with timer, unbanked/banked credits, mission objective/countdown, interaction prompt, threat/link state, and results.
- Native Web Audio for essential-but-redundant cues, with mute, volume buses, reduced intensity, gesture unlock, and voice cap.
- Rallar Data for settings, loadout ID, onboarding/room recents, and bounded debug artifacts.
- Hidden diagnostics overlay with authority epoch, lane/readiness/egress, RTC/WS state, snapshot cadence/age, Motion mode/confidence/delay, simulation tick time, FPS, and recovery state.
- Observability must use bounded structured events and the existing Rallar diagnostics/artifact contracts; production UI shows friendly state while the operator overlay preserves actionable transport and simulation evidence.

#### Recovery and operations

- Stale director pauses the round and blocks outcomes.
- If migration is retained as an MVP requirement, checkpointed pause/re-elect/sync must resume within 10 seconds or terminate cleanly without split-brain.
- HTTPS/WSS staging, working TURN route, health checks, redacted logs, and no client-exposed provider/TURN secrets.

### Explicit MVP non-goals

- Ranked play, cheat-resistant progression, real money, purchases, inventory, accounts beyond existing Rallar identity, or server-persisted CCA results.
- Server-authoritative simulation unless the product owner selects that authority model before implementation.
- Rescue/forced-movement missions, combat, classes, perks, abilities, wall-run, slide, roll, crouch, or root-motion authority.
- Full mobile/touch gameplay. Mobile may join/spectate only if that flow is deliberately supported.
- Rallar CRDT creator/review documents.
- AI-required maps, missions, cosmetics, live Sentinel logic, or browser model download.
- Polished humanoids, asset-heavy GLB pipeline, custom rigs, mesh collision, physics engine, R3F, Drei, postprocessing, or elaborate particles.
- Match replay, social graph, matchmaking, public lobbies, voice/video calls, leaderboards, analytics warehouse, or durable playtest-report storage.

### Functional acceptance criteria

| Area                 | Acceptance criterion                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room flow            | Two through eight independent browser contexts can create/join one scoped room, see the same active roster, ready, and leave without stale UI.                                                       |
| Election             | Given the same fresh capabilities and members, every client derives the same host/backup; only the elected eligible session appoints; no second app lease exists.                                    |
| Readiness            | Match does not start until the configured expected peers and required input/snapshot lanes are open, or the host explicitly resolves a timed-out peer.                                               |
| Authority            | Only the fresh authority epoch can produce accepted snapshots/events/results. Wrong room/match/sender/epoch and duplicate/stale sequences are rejected before game handlers.                         |
| Simulation           | Identical seed + ordered validated inputs produce identical state hashes for a representative full round in Node and browser worker tests.                                                           |
| Fairness             | All cosmetic presets resolve to identical capsule, speed, stamina, dash, vault, interact, scoring, and visibility constants.                                                                         |
| Game loop            | Players can move, evade a Sentinel, complete each of the three missions, accumulate credits, be caught, cash out, spectate, and see deterministic standings.                                         |
| Fallback             | With AI unavailable/disabled/timed out/malformed, match starts with valid deterministic content and no degraded rules.                                                                               |
| Motion               | Remote entities interpolate, extrapolate only within the configured short window, hold afterward, reject stale samples, and snap/hold on defined discontinuities.                                    |
| Recovery             | If required: in at least 9/10 controlled director-loss runs, peers agree on one higher epoch and resume in ≤10 seconds; no old-epoch outcome is accepted. Remaining runs terminate clearly.          |
| Persistence boundary | Static review/tests prove simulation does not read Rallar Data and CCA server code does not open app-owned match/game stores.                                                                        |
| Accessibility        | Every gameplay action is remappable; menus are keyboard/focus operable; essential cues are not color-only or audio-only; reduced motion/intensity and HUD scale work.                                |
| UX                   | In observed playtests, at least 80% of players can identify the active mission objective within five seconds; product metrics retain the existing ≥60% match completion and ≥50% second-round goals. |

### Proposed performance budgets

These are **recommendations and measurement gates**, not measured CCA performance.

| Metric               | MVP budget and workload                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lobby critical JS    | ≤250 KiB Brotli, excluding lazy renderer and AI/provider code. Rallar full facade currently accounts for 160.1 KiB Brotli in isolation.                                                           |
| Lazy renderer chunk  | ≤500 KiB Brotli before model/audio assets; renderer bake-off must report minified, gzip, and Brotli.                                                                                              |
| Lobby interactive    | ≤2.5 seconds in a repeatable Fast-4G/mid-tier-desktop lab profile, cold cache; no 3D or AI on the critical path.                                                                                  |
| Setup-to-first frame | ≤1.5 seconds after deterministic setup commit with procedural arena on the reference desktop.                                                                                                     |
| Frame time           | Target 60 FPS; p95 main-thread frame ≤16.7 ms in the representative 8-player/6-Sentinel/40-obstacle scene. Adaptive 30 FPS tier is allowed on low capability, with explicit diagnostics.          |
| Simulation           | 30 Hz; p95 director simulation step ≤4 ms and worst observed step <16 ms on the reference host workload.                                                                                          |
| Snapshot/input rates | Start at 12 Hz snapshots and 20 Hz input as documented; change only from traces. Snapshot payload p95 ≤4 KiB at eight players; input payload ≤256 bytes before transport framing.                 |
| Host bandwidth       | Target ≤3 Mbit/s aggregate game-data outbound at seven remote peers in the representative match; record relay versus direct ICE paths separately.                                                 |
| Memory               | Browser heap/engine memory remains bounded during a 15-minute soak; target <250 MiB application heap and <5% retained growth after warm-up. GPU memory must be reported where tooling exposes it. |
| Long tasks           | No recurring >50 ms main-thread task during active play; one-time setup tasks must not overlap match start.                                                                                       |
| Recovery             | Pause-to-resume ≤10 seconds where migration is enabled.                                                                                                                                           |

Performance findings remain **Needs measurement** until CCA exists. Static risks to validate first are per-frame React updates, per-snapshot JSON allocation/serialization, entity-array scans, unbounded debug/event buffers, scene resource leaks, excessive lights/materials/draw calls, and host fanout bandwidth.

### Browser and device support

- **Gameplay support target:** current stable desktop Chromium/Edge, Firefox, and Safari on macOS, subject to real WebRTC/TURN tests. CI WebKit is useful but is not a substitute for Safari hardware testing.
- **Primary input:** keyboard and mouse. Gamepad is post-MVP unless accessibility research elevates it.
- **Mobile:** responsive lobby/error/spectator surfaces only; touch-only active play is explicitly unsupported in MVP and must say so before joining a match.
- **Graphics:** WebGL2 renderer with a low-effects tier. WebGPU must not be required.
- **Failure:** browsers without required RTC, Pointer Lock/input, graphics, or audio behavior receive a capability report and actionable fallback/unsupported message rather than a broken canvas.

### Security, privacy, and abuse requirements

- Provider keys, TURN credentials, and server secrets never enter the client bundle or logs.
- Validate protocol version, payload shape/size, sender/room/match/epoch/sequence, coordinate bounds, action rate, cooldown, and proximity before simulation mutation.
- Cap input rate, queue size, room size, AI prompt/theme length, AI timeout, generated object count, debug log size, and local retention.
- Sanitize/escape all player and AI-generated text; never render generated HTML.
- Browser-director disclosure states that the host can manipulate an unranked room and consumes upload/CPU/battery.
- Cheating protection in browser-director mode is limited to validation, bounds, rate limits, epoch/order checks, and social disclosure; it is not a trusted anti-cheat boundary.
- No CCA server persistence means no silent telemetry. Any export/aggregation requires consent, redaction, a retention period, and a product decision.
- Interrupted rounds and stale authorities cannot emit a trusted result.

### Resolutions applied to the updated documents

1. Browser-director authority is the unranked MVP target; current Rallar server authority is the path for trusted production outcomes.
2. ≤10-second pause/re-elect/sync migration is a mandatory controlled MVP gate; unrecovered rounds end interrupted without a result.
3. Caught and cashed-out players become spectators; no MVP respawn/reentry.
4. Initial playtest defaults are 240 seconds, 10 credits per active second, and standard cash-out unlock after 60 seconds; Sentinel/mission tuning remains measured configuration.
5. Active MVP play is desktop keyboard/mouse; mobile supports lobby/spectator messaging only.
6. Architecture is renderer-neutral; direct Three.js leads an identical measured bake-off against modular Babylon; R3F/Drei are excluded.
7. AI and CRDT are outside the core MVP critical path.
8. Early metrics use manual/consented local export unless a separate aggregate telemetry policy is approved.
9. One participant has one active seat; late joiners and expired reconnects spectate; voluntary leave loses unbanked credits; network host eligibility is independent of runner state.
10. Timer expiry loses unbanked credits; standings and rematch reset use explicit deterministic rules.
11. Integer ticks, boundary quantization, stable ordering, fixture-locked RNG, canonical versioned hashes, and Node/Chromium/Firefox/WebKit parity are implementation gates.
12. Protocol/simulation/content/build compatibility, typed errors, cancellation, idempotent disposal, bounded/redacted diagnostics, page/audio/WebGL lifecycle, dependency/asset review, and rollback are normative engineering requirements.
13. A non-3D checkpoint/ack/promote/restore spike must prove migration feasibility before renderer work; full public Rallar migration remains Gate 6.

## 9. Risk register

| Risk                                                 | Probability             | Impact                 | Evidence / confidence                                                      | Mitigation                                                                                      | Validation experiment                                                                           |
| ---------------------------------------------------- | ----------------------- | ---------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Director disconnect ends or corrupts round           | High                    | Critical               | **Verified platform gap:** stale detection without auto-election.          | Generic Rallar migration orchestration, acknowledged checkpoints, epoch gate, clean abort.      | 100 scripted disconnects at random ticks; verify one epoch, state hash, ≤10s or clean end.      |
| Full connectivity costs more than assumed star       | Medium                  | High                   | **Proven from code:** every peer connects to every peer in current `star`. | Measure 2/4/8 peers; accept for MVP or add generic director-star.                               | Record peer count, CPU, upload, setup time, failures with direct and TURN ICE.                  |
| Browser host cheats/manipulates score                | High for malicious host | High if results matter | **Proven by trust model:** browser result is room-trusted.                 | Unranked/ephemeral disclosure; server authority for rewards/ranking.                            | Attempt modified client inputs/state; verify product never labels result server-validated.      |
| Passive hiding dominates missions                    | Medium                  | High                   | **Inference:** survival income is guaranteed; mission economy unspecified. | Arena sightlines, mission pressure, reward tuning, Sentinel escalation.                         | Instrument movement/mission participation; compare mission reward variants in playtests.        |
| AI delays lobby or generates invalid content         | Medium                  | Medium/High            | No caching allowed; AI on setup path in product wording.                   | Deterministic default, hard deadline, strict schemas/domain validation, no critical dependency. | Inject timeout/malformed/stale/duplicate/provider failure; time-to-match remains inside budget. |
| Renderer misses fastest-load goal                    | Medium                  | High                   | Existing Babylon artifacts are large; CCA/Three unmeasured.                | Direct renderer, lazy chunk, procedural MVP, no R3F/Drei/postprocess, explicit budget.          | Identical Three/Babylon scene build and throttled cold-load profile.                            |
| Main-thread render blocks host simulation            | Medium                  | High                   | **Inference:** host also renders and fans out; no worker in docs.          | Dedicated simulation worker, bounded messages, fixed-step catch-up cap, visibility policy.      | CPU throttle + heavy scene; assert tick p95 and snapshot cadence.                               |
| Snapshot JSON/fanout exceeds host bandwidth          | Medium                  | High                   | Rates exist but no payload budget; up to seven recipients.                 | Compact full snapshots first, latest-value flow control, measure before binary/delta.           | 8-player worst-case traffic capture on direct/TURN; profile serialize/GC/bandwidth.             |
| Reconnect accepts stale state/split brain            | Medium                  | Critical               | Rallar epoch guards exist, migration protocol absent.                      | Appointment epoch as sole authority epoch, recovery commit, full snapshot discontinuity reset.  | Partition old host, promote backup, reconnect old host, assert all old outcomes rejected.       |
| Cross-browser RTC/renderer differences               | Medium                  | High                   | Current Playwright configs are Chromium-only.                              | Firefox/WebKit CI, manual Safari, TURN matrix, capability/error UX.                             | Repeat join/play/reconnect/migrate flows per browser pair where feasible.                       |
| Resource leaks over repeated rounds                  | Medium                  | Medium/High            | Existing game scenes have complex lifecycle; CCA nonexistent.              | Explicit disposer ownership for subscriptions, timers, workers, scene, audio, Motion tracks.    | 20-round soak; heap snapshots, listener/track counts, GPU/resource counters.                    |
| Accessibility added too late                         | Medium                  | Medium/High            | Only reduced-motion/settings references today.                             | Input actions abstraction, semantic DOM, color/audio redundancy from first slice.               | Keyboard-only flow, contrast/zoom/reduced-motion tests, external accessibility review.          |
| Telemetry conflicts with no-persistence/privacy rule | High                    | Medium                 | Product metrics exist; storage path forbidden.                             | Manual playtest form or approved redacted consented export.                                     | Data-flow review proves fields, consent, redaction, retention, deletion.                        |
| Scope expansion delays playable loop                 | High                    | High                   | AI, CRDT, assets, migration, five missions appear across prompts.          | Gate order in section 10; exactly three missions; AI/CRDT/assets deferred.                      | At each gate, reject work not required by exit criteria.                                        |
| Original-IP similarity risk                          | Low/Medium              | High                   | Explicit intent but no review process.                                     | Naming/art/audio/reference review before external assets/marketing.                             | Independent IP/style review against prohibited references.                                      |

## 10. Recommended implementation sequence

Each gate ends in demonstrable behavior. Do not begin later scope because code scaffolding makes it convenient.

### Gate 0 — approve product and platform decisions

**Build:** nothing. Resolve the eight decisions at the end of section 8; define initial game tuning hypotheses and the migration requirement.

**Exit:** approved reconciled product/architecture documents and no unresolved authority/MVP contradiction.

### Gate 1 — pure deterministic rules and protocol

**Build:** `packages/cash-chase-arena` with versioned compact payloads, validators, fixed-step simulation, arena fallback/validator, movement/collision, three mission templates, scoring/catch/cash-out, snapshot/checkpoint creation, and state hashing.

**Exit:** deterministic replay/hash tests pass; invalid inputs/layouts/checkpoints are rejected; no browser/React/renderer/Rallar runtime import; representative step time is measured.

### Gate 2 — Rallar lobby and authority spine

**Build:** minimal Vite/React app with auth, create/join/switch room, roster/ready, capability report, Rallar Game election/appointment, readiness, status and diagnostics. Use a DOM 2D/debug view only.

**Exit:** two then eight contexts agree on room, host, backup, epoch, lane status; no raw transports or duplicate lease/election code.

### Gate 3 — playable networked 2D vertical slice

**Build:** simulation worker/bridge, compact input, snapshots/events, reliable setup/start/sync, Rallar Motion presentation, local prediction correction, one Sentinel, one cash-out, one representative mission.

**Exit:** two-browser full round works under induced jitter/loss; stale/wrong envelopes are rejected; reconnect sync works; payload, bandwidth, tick, and allocation traces are recorded.

### Gate 3.4 — non-3D migration feasibility

**Build:** a test-first, opaque-checkpoint harness using current Rallar Game election, appointment, lanes, envelopes, status, and diagnostics. Prove publish-to-backup, acknowledgement, stale pause, one-higher-epoch promotion/restore, old-epoch rejection, and bounded clean abort without renderer or app-local transport.

**Exit:** at least 100 deterministic random-tick cases restore the acknowledged hash or interrupt within 10 seconds; unresolved generic Rallar architecture blocks renderer investment.

### Gate 4 — complete procedural MVP loop

**Build:** 2–8 players, fallback arena recipes, all three missions, Sentinel state machine, full score/caught/cash-out/results, local settings, audio cues, onboarding, operator overlay.

**Exit:** functional criteria pass in the debug renderer; playtests show the loop is understandable and worth rendering in 3D.

### Gate 5 — renderer decision and 3D integration

**Build:** time-boxed identical direct-Three and modular-Babylon prototypes using the same procedural arena, capsules, camera, Motion poses, resource disposal, and debug counters. Choose from measurements. Integrate only the winner behind `CashChaseRenderer`.

**Exit:** chosen renderer meets bundle/first-frame/frame-time/memory budgets and visual/control QA. No R3F/Drei/postprocessing unless the experiment separately proves value within budget.

### Gate 6 — migration and multiplayer hardening

**Build:** if approved for MVP, generic Rallar Game migration orchestration plus CCA checkpoint/restore; late join, reconnect, TURN, visibility/background, stale host, and split-brain handling.

**Exit:** controlled migration and soak criteria pass; failures terminate clearly; no old epoch accepted.

### Gate 7 — accessibility, browser, performance, and staging

**Build:** remapping, semantic/focus UI, color/audio redundancy, reduced motion/intensity, graphics tiers, cross-browser fixes, staging/env/runbook/health checks, CCA shared-test recipes and visible Playwright flows.

**Exit:** supported browser matrix, performance budgets, security review, staging TURN path, and 20-round soak pass.

### Gate 8 — optional variety after core validation

**Build:** server-side Rallar AI proposals with deterministic fallback and strict lifecycle. Later, GLB assets and dev-only optimization. CRDT only after an approved creator/review feature.

**Exit:** disabling AI/CRDT/assets never prevents basic play; every accepted proposal is validated and deduped; bundle critical path is unchanged.

### Parallelizable work

- After Gate 1 contracts stabilize, UI accessibility shell, deterministic content, and black-box recipe design can proceed independently.
- Audio presentation and renderer bake-off can proceed after semantic events and Motion pose contracts stabilize.
- Migration platform work can proceed beside game-loop work once the checkpoint interface is frozen.
- AI schemas can be drafted after arena/mission validators stabilize, but provider integration waits until Gate 8.

## 11. Validation strategy

### Test layers

1. **Pure unit/property tests:** simulation, collision, missions, economy, validators, deterministic replay/canonical hash, RNG fixtures, stable simultaneous ordering, snapshot/checkpoint, lifecycle outcomes, cosmetics, input normalization, camera math, and Node/Chromium/Firefox/WebKit parity.
2. **Rallar contract tests:** CCA adapter composes public Rallar Game APIs; payload routing, readiness, fallback, egress, diagnostics, epoch/sequence, sync, disposal.
3. **Worker integration tests:** fixed-step scheduling, pause/resume, main/worker message bounds, catch-up cap, visibility/background behavior.
4. **Browser component tests:** lobby forms, focus, remapping, settings, pointer lock release, HUD, errors, reduced motion, diagnostics.
5. **Multi-context Playwright:** visible create/join/ready/start/play/mission/cash-out/results/reconnect/migrate flows.
6. **Rallar black-box recipes:** RTC delivery/readiness/failure, WS fallback, director status, multi-browser traffic, TURN/live services, artifact analysis.
7. **Visual QA:** nonblank canvas, camera/occlusion, capsule/visual alignment, silhouettes, HUD safe area, color-independent cues, graphics tiers.
8. **Performance/soak:** cold/warm load, CPU/frame/tick, serialize/GC, bandwidth, heap/resource growth, repeated rounds, host migration.
9. **Security/data-flow review:** secrets, payload/rate bounds, AI text/schema, host disclosure, trust label, persistence/telemetry boundary.

### Existing Rallar verification commands

Run focused checks first:

```sh
npx vitest run packages/tests/shared-web/rallar-game-match.test.ts \
  packages/tests/shared-web/rallar-game-diagnostics.test.ts \
  packages/tests/shared-web/rallar-game-election.test.ts \
  packages/tests/shared-web/rallar-game-lanes.test.ts \
  packages/tests/shared-web/rallar-game-envelopes.test.ts

npx vitest run packages/tests/shared/rallar-motion.test.ts \
  packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-message-channel.test.ts

npx vitest run packages/tests/shared/rallar-ai-contracts.test.ts \
  packages/tests/shared-web/rallar-data.test.ts \
  packages/tests/shared-web/rallar-crdt.test.ts

npx vitest run packages/tests/shared-web/rallar-game-authority-client.test.ts \
  packages/tests/shared-server/rallar-game-authority-server.test.ts

npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
```

The public-surface and existing-game builds are mandatory when migration/topology work changes shared Rallar exports or behavior; they are not required for CCA-only pure game rules.

After CCA exists, add stable workspace commands such as:

```sh
npm --workspace cash-chase-arena run typecheck
npm --workspace cash-chase-arena run test
npm --workspace cash-chase-arena run build
npx playwright test --config apps/cash-chase-arena/playwright.config.ts
```

Use existing broader/live infrastructure where applicable:

```sh
npm run test:rallar:full-stack:memory:live-rtc-3
npm run test:rallar:full-stack:memory:director
npm run test:shared-black-box:matrix:traffic
npm run test:shared-black-box:matrix:soak
```

If CCA adds or changes REST behavior, add black-box recipes in `packages/shared-test/black-box-runner` in the same change and run:

```sh
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres   # when Postgres is available
```

### Required multiplayer scenarios

- 2, 4, and 8 players; direct ICE and TURN relay.
- Slow join, missing capability, stale capability, non-elected appointment, owner offline/member fallback.
- Partial/no-target/not-ready input and snapshot lanes; WS fallback for reliable messages.
- Duplicate, reordered, delayed, malformed, wrong-room, wrong-match, spoofed-sender, old-epoch, and oversized payloads.
- Refresh, tab close, background throttling, network offline/online, ICE restart, reconnect, late join, director loss, old director return.
- Setup AI timeout/invalid/duplicate/stale result with deterministic fallback.
- Repeated create/join/leave/switch and 20 consecutive rounds without listener/timer/worker/audio/scene leaks.

### Performance measurement plan

| Hypothesis                                     | Confirmation/falsification                                                                                                         | Tool / workload                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Renderer stack threatens startup budget        | Confirm if renderer chunk or first frame exceeds section 8; falsify if both candidates pass and one is materially simpler/smaller. | Vite build sizes, Brotli/gzip, throttled cold load, identical scene.       |
| Host render delays 30 Hz simulation            | Confirm if tick p95 >4 ms or cadence gaps correlate with frame work; falsify under CPU throttle/heavy scene.                       | Worker/main performance marks, Chrome/Firefox profiles, 8-player workload. |
| JSON snapshots cause serialization/GC pressure | Confirm via serialize time/allocation/GC and payload budget; falsify if comfortably bounded.                                       | DevTools allocation/CPU, transport byte counters, 12 Hz 15-minute run.     |
| Full RTC connectivity is costly at eight peers | Confirm via setup failures, CPU, memory, connection count, upload; falsify within budgets.                                         | Rallar RTC diagnostics, `getStats`, direct/TURN 2/4/8 matrix.              |
| Scene resources leak between rounds            | Confirm retained heap/GPU/resources grow after warm-up; falsify after 20 rounds.                                                   | Heap snapshots, renderer counters, listener/timer/worker counts.           |
| Debug/telemetry buffers grow unbounded         | Confirm retained entries/heap increase with match duration; falsify at configured caps/TTL.                                        | 15-minute soak, Rallar Data usage estimate, heap inspection.               |

Runtime profiles belong under `tmp/perf/` and must record commit, browser/runtime, hardware, config, workload, and repeated runs. Static concerns are hypotheses until measured.

### What cannot be validated yet

- CCA gameplay, fun, economy, controls, camera, accessibility, renderer, audio, bundle, frame time, memory, and network payloads: no CCA app/package exists.
- Automated migration: current Rallar has partial primitives, not the required orchestration.
- Three.js cost/integration: it is not installed and no equivalent CCA scene exists.
- Cross-browser production support: current relevant Playwright configurations are Chromium-only and live services/hardware were not run for this document review.
- TURN, staging SLOs, server AI latency/cost, and consented telemetry: environment and policy decisions are missing.

## 12. Final decision list

### Accept unchanged

- Original-IP chase/cash-out concept and no real money.
- 2–8 private-room MVP.
- Rallar as the exclusive application communication platform.
- Package/app separation and pure deterministic rules.
- Browser-director as a valid **unranked MVP** option.
- Fixed capsule, cosmetic-only identities, renderer-owned visuals, in-place animation.
- Rallar Motion for presentation only; Data for local latest-value state only; CRDT for authored collaboration only; AI as validated proposal data only.
- Deterministic fallback arenas/decks before AI.
- Rallar vertical slice before renderer polish.

### Change

- Replace “physical star topology” with “director-routed authority over Rallar room RTC” unless a new director-star topology is implemented.
- Remove CCA-owned host election, lease, lane, and envelope infrastructure; compose current Rallar Game.
- Rename the reusable package to `packages/cash-chase-arena` unless repository naming owners prefer the existing proposed name.
- Use envelope sender/sequence/time/epoch instead of duplicating trusted identity/order fields inside input payloads.
- Reduce MVP to exactly three missions.
- Move AI, CRDT, GLB-heavy art, postprocessing, rescue/forced-movement missions, mobile controls, and browser AI outside the critical MVP path.
- Replace locked React Three Fiber/Drei stack with a renderer-neutral adapter and measured direct-Three recommendation.
- Add simulation worker, explicit audio, accessibility, browser, performance, security, telemetry, and lifecycle acceptance criteria.
- Regenerate the prompt pack only after specifications and implementation plan are approved.

### Decide by experiment

- Direct Three.js versus modular Babylon for the representative scene.
- Full Rallar room connectivity versus need for director-star at 2/4/8 players.
- Snapshot full JSON versus later binary/delta representation.
- Initial Motion delay/extrapolation/correction parameters.
- Simulation on worker from Gate 1 versus moving before 3D integration; recommendation is worker before host/render load matters.
- Game economy, Sentinel pressure, mission reward, and arena scale through instrumented playtests.

### Applied default resolutions

1. **Authority:** unranked room-trusted browser director for MVP; server-validated Rallar authority for future trusted outcomes.
2. **Migration:** mandatory controlled MVP gate at ≤10 seconds, otherwise clean interruption without result.
3. **Caught state:** elimination to spectator with loss of unbanked score; no respawn/reentry.
4. **Economy:** 240-second round, 10 credits/active second, standard cash-out after 60 seconds; remaining tuning is configuration and experiment.
5. **Platform:** desktop active play and mobile lobby/spectator only.
6. **Renderer:** renderer-neutral adapter, direct Three as leading candidate, identical measured Babylon comparison, no R3F/Drei.
7. **Scope:** AI and CRDT deferred until after the playable, hardened loop.
8. **Metrics/privacy:** manual/consented local measurement unless a separate aggregate telemetry/export policy is approved.

## 13. Engineering readiness addendum

The July 13 follow-up closes the documentation gaps identified after the original product/platform audit without expanding the runtime stack.

| Finding                                                  | Applied resolution                                                                                                                                                           | Authoritative location                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Coding conventions lived only in repo skills             | Added functional-first module rules, `Readonly`/discriminated-result guidance, dependency injection, public-export discipline, and human-readability rules.                  | `Cash_Chase_Arena_Engineering_Standards.md`                              |
| Determinism lacked a numeric/canonical contract          | Added integer ticks, boundary quantization, stable ordering, `xorshift32` fixtures, canonical versioned hashing, and cross-engine parity.                                    | Engineering standards; architecture simulation; implementation Gate 1    |
| Versioning did not define compatibility/deployment       | Added protocol/simulation/content/hash/build pinning, exact major matching, compatible-additive rules, stale-client refresh, and checkpoint-version abort.                   | Engineering standards; architecture protocol; implementation Gates 0–1/7 |
| Errors and asynchronous lifecycle were underspecified    | Added stable typed error families, user-safe versus diagnostic detail, abort/generation ownership, idempotent disposal, and no silent catches.                               | Engineering standards; architecture runtime/error sections               |
| Room/game edge cases lacked canonical outcomes           | Added duplicate-seat, late-join, reconnect grace, voluntary leave, timer-expiry, host-while-spectating, tie-break, removal, and rematch rules.                               | Product lifecycle section; pure/integration test tasks                   |
| Highest platform risk appeared after renderer investment | Added Gate 3.4 non-3D migration feasibility before Gate 5, while retaining full public Rallar migration hardening at Gate 6.                                                 | Architecture feasibility gate; implementation plan; prompt 8             |
| Tooling/style was advisory rather than enforceable       | Required checked-in Prettier/ESLint configuration, named workspace checks, prohibited dependency fixtures, and repository tool reuse.                                        | Engineering standards; implementation Gate 0/scaffolds                   |
| Diagnostics, supply chain, and release were incomplete   | Added structured capped/redacted diagnostics, CSP/origins, dependency and asset provenance/license review, stale-client/cache policy, TURN capacity, and rollback.           | Engineering standards; implementation Gate 7; prompt 14                  |
| Product tuning lacked a repeatable evidence protocol     | Required fixed-build/environment playtests with consent, facilitator script, observation versus opinion, comprehension, completion/rematch, strategy, and deletion evidence. | Engineering standards; implementation Gate 4; prompt 9                   |

The remaining feasibility risks require implementation evidence rather than more framework guidance: migration orchestration, real direct/TURN 2/4/8-player traffic, mixed-browser parity, renderer measurements, and game-loop playtests.

## Appendix A — review evidence and limitations

### Repository sources inspected

- `AGENTS.md` and required Rallar platform/games/realtime/AI/testing skills and their package/test references.
- All five `projects/cash-chase-arena/*.md` source documents.
- Browser facade, Rooms, Realtime, Messages, Director, Data, CRDT, AI, Game, Match, Motion, topology, authority, and match-result public code.
- AR Eye Hunter `useRallarArena`, Rallar Game adapter, simulation/AI/audio/test surfaces.
- Relic Hunters runtime, server authority/data service, Babylon scenes, Rallar Motion networking, and tests.
- Shared Rallar unit/integration tests, three-browser live RTC and director orchestration specifications, bundle scripts, package/workspace configuration.

### Commands run for this analysis

- Focused Vitest command in section 5: **passed, 12 files / 137 tests**.
- `npm --workspace @ar-eye-hunter/shared-web run measure:browser-bundles`: **passed as reporting run**; all defined budgets reported `ok`.
- Isolated esbuild measurements for Rallar Game, Motion, and browser AI: completed under `/tmp`; these were analysis artifacts, not committed files.
- Existing ignored `dist` artifacts were inspected only as comparative size signals; they were not rebuilt and are not proof of CCA cost.

### Not run

- Full unit, Deno, Postgres, live RTC, or Playwright suites: unnecessary to prove a document-only analysis and may require services/browser environments.
- CCA build/tests/runtime/profiles: no CCA implementation exists.
- External web research: no external compatibility fact was necessary for the conclusions; browser/library support remains a required future measurement matrix.

## Conclusion

The follow-up document updates have applied the recommended product defaults and the engineering-readiness findings. The implementation path is now strict/canonical pure rules, a deterministic 2D Rallar vertical slice, a non-3D migration feasibility proof, the complete procedural loop, measured renderer selection, public migration hardening, and only then AI/art/creator expansion. Remaining uncertainty is deliberately resolved by tests, browser/TURN measurements, and playtests rather than additional runtime frameworks.
