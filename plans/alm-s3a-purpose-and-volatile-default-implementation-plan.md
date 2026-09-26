# ALM S3a Purpose and the Volatile Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A typed channel declares `purpose: 'command' | 'notification'`, and a typed send with no
options becomes what D2 promises — at-least-once, receipted, volatile, 30 s — with volatile work held
in a memory store pair beside the IndexedDB pair on every browser carrier runtime, and the lane
proving zero `al-admission` and zero non-probe `al-work` IndexedDB operations for a volatile send.

**Architecture:** One purpose table in `packages/shared/al-contracts/` resolves the channel's send
defaults; the browser sender stamps them on the envelope (`delivery.ack`, `reliability`, `ttlMs`,
`qos.durability`), so the effective policy carries the purpose and nothing new is persisted. The
handle reads its receipt algorithm from the effective policy. Durability stops being derived from
reliability: `shouldPersistOutbox` reads durability alone, and the old "may wait for a route" meaning
keeps its own name (`shouldAwaitALRoute`) for the WS server and the RTC missing-channel check. Each
browser outbound runtime and the per-session inbound store hold a durable (IndexedDB) and a volatile
(memory) store lane on the shared engine and route every admission by the message's durability; the
volatile lane evicts its expired rows on its own work round. The server keeps one PostgreSQL backend.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest; Playwright; dprint; the Hetzner
manifest generator.

**Spec:** [playground/alm/alm-s3-design-proposal.md](../playground/alm/alm-s3-design-proposal.md) §1.1,
§1.3, §2.1, §3, §7, §8; [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md)
("Purpose at the channel", "Deadline", "Admission outcomes", "Storage, cutover, reset, and rollback",
the S3 bullet under "Release 3, Slice 2: outcomes", decisions D2, D3, D6, D8, D9, D15, D17, D20,
D52–D61 — D53 and D59 only as constraints). S3a starts from merged `main` `d8e72dca5` (S2c-ii, #595)
plus the two S3 docs commits (`d3208724c`, `019676520`).

## Global Constraints

The S2c-ii constraints apply unchanged (D8 search-first, no legacy, touched-file closure, canonical
verbs, values not exceptions, required fields, the size tiers, the harness budgets, the bundle rule,
the non-blocking lane, the push-time gate list, maintainer-reviewed landing), plus:

- **No migration.** Reset-on-mismatch is the only lever (D3, D17). `AL_ADMISSION_SCHEMA_ID` stays
  `rallar-alm-2026-09-s2c-ii`: S3a persists no new field. The purpose resolves into existing envelope
  fields (`delivery.ack`, `delivery.reliability`, `constraints.expiresAtMs`, `qos.durability`), the
  captured policy keeps its shape (`persist` already records the durable choice), and the memory pair
  persists nothing. A task that adds a field to any persisted shape (captured policy, sent snapshot,
  admission or control rows) must bump the id to `rallar-alm-2026-10-s3a` in the same commit.
- **No new third-party dependency** (D8).
- **No new timer, queue or registry beyond the memory pair.** The memory pair reuses
  `InMemoryAdmissionBackend` + `InMemoryQueueBox`; its expired rows are evicted on the owning lane's
  existing work round, rate-limited by the clock (`AL_VOLATILE_STORE_EVICTION_INTERVAL_MS`), never by a
  timer of its own. No store registry scope is added: each carrier runtime owns its memory pair, the
  inbound memory pair is created once per middleware (per session) and handed to both carriers (D20).
- **Harness budgets fixed:** `CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, regimes 30/35 ms.
- **Bundle ceilings:** facade 220 KiB (measured 219.8), headless 281 KiB (measured 280.05), raised only
  by the next-whole-KiB rule with the measured figure recorded in the test comment and the task commit.
- **Storage pins move only where the volatile default leaves nothing to count**, with figures
  recorded: the durable pins (10 `al-admission` + 15 `al-work` per durable send, 8 admission operations
  per durable inbound admit-and-deliver, the durable storage snapshot) keep their figures under
  durable names; the volatile pins read 0.
- **`rallar.realtime` untouched** (D15). **S1's handle surface extends additively**: `ackMode` keeps
  its type and meaning (the envelope's requested wire mode); `receiptAlgo` is added beside it.
- **D53 is S3c's.** `receiver` on a WS unicast stays refused `unsupported` in S3a; see "The S3a
  behaviour for `command` over a WS unicast" below.
- **D59 is S3c's.** No capacity bound, no `refused/capacity` verdict and no `overloaded` producer in S3a.
- **The server keeps one backend.** The WS server's outbound and inbound runtimes get
  `volatileStores: undefined`; its planner's `persist` keeps its pre-S3a meaning under
  `shouldAwaitALRoute`.
- Files at cognitive-load warn that S3a touches take call lines only; new behaviour goes into new files
  beside them: `web-rtc-overlay-multicast-manager.ts` (94, 913 lines), `al-policy.ts` (94),
  `normalize-al-qos-policy.ts` (79), `ws-queue-box-client-service.ts` (54). `al-outbound-message-runtime.ts`
  (892 lines) and `al-inbound-message-runtime.ts` (576 lines) shrink: their per-store halves move into
  the new lane files.
- **Per-task validation** (every task, before its commit; a task names the extra gates it needs):
  - the focused Vitest files the task names (`npx vitest run <files>`), then `npm run test:unit`
    (both Vitest roots) before the push;
  - `npm run typecheck` (includes `npm run typecheck:tests` = `node scripts/check-tests-typecheck.mjs`);
  - `npm run check:repo-style:changed -- origin/main HEAD`;
  - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
  - `npx dprint check <every touched file>` (never a glob — `dprint fmt` only on the touched files);
  - `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server && deno task check`
    and `npm run test:deno` whenever `packages/shared`, `packages/shared-server` or
    `packages/shared-test` changed;
  - for any `packages/shared-web` or `packages/shared` change reaching the browser:
    `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
    and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - the smoke lane `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm`
    (loopback ports: run unsandboxed; verify the summary line, not the exit code);
  - `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` whenever a
    conformance recipe changes, and `npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`;
  - `npm run test:repo-governance` when docs under `docs/`, `examples/` or `.agents/` change;
  - the medium-scale Postgres gate `npm run test:api-v1:black-box:postgres:medium-scale` only if a
    server mutation path changes behaviour. S3a's one server edit (Task 3) keeps the WS server
    planner's `persist` value for every message the server receives; see "Rulings to take before
    execution".
- Acceptance follows D51: the local full lanes on normal pages plus the both-normal hosted smoke; the
  hosted full read is attempted at most twice and reported, never a blocker.
- PRs land through the maintainer's review: no `pr:delivery -- ready`, no auto-merge.

### The S3a behaviour for `command` over a WS unicast

A typed channel produces only room targets in S3a: `send`/`sendRtc` build a room multicast,
`sendWs` a room broadcast (or a `world`/`all` broadcast when the caller names that scope). No typed
channel send is a unicast. The only browser unicast is `BrowserRallarMessageSender.sendWsUnicast`
(the director relay's WS fallback, `browser-rallar-message-sender.ts:104-129`), which is not a typed
channel, carries no purpose, and keeps its best-effort, `ack: 'none'` envelope until S3c moves the
intents (D60) and lifts the refusal (D53). So in S3a:

- `command` and `notification` both default to a logical receipt on every room target, on every
  carrier (`command` → wire `ack: 'receiver'`, `notification` → wire `ack: 'all-logical-recipients'`,
  one algorithm under two names, D41);
- a `world`/`all` broadcast from a typed channel keeps `ack: 'none'` (A1 owns those audiences; a
  `receiver` default there would be refused `unsupported` on every send);
- a test pins that `sendWsUnicast` still builds an envelope with no `delivery` block.

The cost of this over the controller's recommendation ("`command` defaults `receiver` for RTC/room
targets and the WS unicast keeps `hop`") is none: the WS unicast never sees a purpose, so no
carrier-dependent cell is needed in the purpose table. The alternative — a carrier-aware table that
resolves `hop` for a WS unicast — adds a code path no S3a caller can reach.

### How the receiving side learns the durability

From the message, never from a receiver-side lookup: the sending channel's declared durability
travels as the envelope's `qos.durability` (Task 1), and the inbound runtime routes on
`resolveALInboundStoreDurability(msg)` — `durable` exactly when the envelope's normalized durability is
`local-inbox` (Task 5). `local-outbox` persists the sender's copy only (the product description's
definitions, `alm-complete-product-description.md` "Durability and browser-local storage"). This needs
no registry of receiving channels, works for a message that arrives before its subscriber and for a
relay that has no channel at all. A receiver-side QoS provider never moves a message between stores;
the handling plan's `localDelivery.persist` stays informational (it is decoded and never read today,
`decode-al-inbound-plan.ts:107-116`).

### Carried into S3a

- **The receipt-less RTC send refusing its receiver hop's NACK** (R-S2c-ii-5a, S2c-ii plan "Carried
  out of S2c-ii"). It dissolves for default sends because the default becomes receipted: the RTC origin
  of a no-options typed room send now keeps a pending-ACK row that expects its hops, so a hop's
  `resync-required` NACK is admitted and settles `relay-rejected` (D50). **Verified by Task 2 Step 5**:
  an envelope built from `resolveALChannelSendDefaults({ purpose: 'notification', … })` through the RTC
  overlay manager settles `relay-rejected` naming the peer hop, and the same envelope with an explicit
  `ack: 'none'` still does not commit the NACK — the carry stays for explicit receipt-less sends and is
  not S3's.

### Carried to S3b / S3c

- **D53 — `receiver` on a WS unicast** (S3c): the one-member aggregate on the server, the unicast
  fallback and the ALM RTC unicast in the sender; typed-channel unicast targets arrive with it.
- **D56 — the retryable outcomes and the fallback controller** (S3b): `not-ready` ×3, `rate-limited`,
  the `not-yet-in-sync` budget, and the new `receipt-exhausted` settlement; the `hop`-mode
  completion-at-dispatch that deletes a row without a settlement (S2c-ii carry) goes with "every
  receipt end settles".
- **D59 — the volatile bound** (S3c): the per-session count and byte bound on the memory pair, the
  typed `refused/capacity` verdict, the first `overloaded` producer; the relay-row retention measurement
  (S2c-ii carry) feeds it. Until then the memory pair is bounded only by message deadlines and
  retention, evicted on the owning lane's round (Tasks 4, 5).
- **D57 — the `server` target kind** (S3c) and **D58 — the server-originated outbox publish and
  cluster delivery honouring the carried audience** (S3c).
- **A literal zero IndexedDB total** (I2, per D55): the durable owners still probe (`work-page`) while
  idle; S3a reports those probes beside the zero.
- **`world`/`all` broadcast receipts** (A1): typed `world`/`all` sends keep `ack: 'none'` in S3a.

---

## File structure

**Purpose and defaults (Task 1):**

- Create `packages/shared/al-contracts/resolve-al-channel-send-defaults.ts` — `ALChannelPurpose`, the
  purpose table `AL_CHANNEL_SEND_DEFAULTS`, `resolveALChannelSendDefaults`.
- Create `packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts` — the channel's
  `purpose`/`durability` validation.
- Create `packages/shared-web/browser/messages/to-browser-message-send-defaults.ts` — the envelope
  defaults for a lane send and for a channel send.
- Modify `packages/shared-web/browser/messages/rallar-message-contracts.ts:8,106-109`,
  `browser-typed-message-channels.ts:30-99`, `browser-rallar-message-sender.ts:61-63,131-227,279-340`,
  `browser-rallar-messages-controller.ts:80-93`, `browser-message-input-validator.ts:147-157`,
  `packages/shared-web/browser/rooms/room-session.ts:58-61,85-110`,
  `packages/shared-web/browser/director/browser-director-relay-transport.ts:136-137`,
  `packages/shared-web/game/authority/rallar-game-authority-client.ts:246-252,296-302`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts:15-19,48-53`,
  `docs/rallar-api-reference.md:612-618`.

**Receipt on the handle (Task 2):**

- Create `packages/shared/alm/delivery/resolve-al-delivery-receipt-algo.ts`.
- Modify `packages/shared/alm/delivery/al-delivery-lifecycle.ts:222-287`,
  `packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts:151-157`.

**Durability decoupled (Task 3):**

- Modify `packages/shared/al-contracts/al-policy.ts:388-395`,
  `packages/shared/al-contracts/normalize-al-qos-policy.ts:179-181,273-276`,
  `packages/shared/services/ws-queue-box-client-service.ts:274`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts:95`,
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:608,673-676`.
- Harness `durability` on `messages.send` (nine registries, listed in Task 3), the ALM conformance
  send helper, `delivery-reload`, `delivery-lifecycle`.

**Outbound store lanes (Task 4):**

- Create `packages/shared/alm/outbound/al-outbound-send-controls.ts`,
  `packages/shared/alm/outbound/al-outbound-store-lane.ts`.
- Modify `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (shrinks to the router),
  `create-default-al-outbound-message-runtime.ts`, `packages/shared/alm/al-runtime-stores.ts`,
  `packages/shared/alm/al-admission-backend.ts` (`evictExpired`), `packages/shared/alm/ALStoreRetention.ts`,
  `packages/shared/alm/delivery/al-delivery-lifecycle.ts:294-301` (doc of `hasALDeliveryDurableWork`),
  `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`,
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts`,
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts`,
  `packages/shared/services/ws-queue-box-client-service.ts:120-137,636-663`.

**Inbound store lanes (Task 5):**

- Create `packages/shared/alm/inbound/al-inbound-store-lane.ts`,
  `packages/shared/alm/inbound/resolve-al-inbound-store-durability.ts`,
  `packages/shared/alm/inbound/control/is-al-origin-acknowledgement.ts`.
- Modify `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (shrinks to the router),
  `create-default-al-inbound-message-runtime.ts`, `packages/shared/services/web-rtc-rx-streamer-service.ts:55-63,489-497`,
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts:163-201,241-256,312-321`.

**The volatile proof (Task 6):** harness counters, two scenarios, the observation work-page rate, the
storage snapshot's volatile leg, the Hetzner manifest.

**Capabilities (Task 7, droppable):** Create `packages/shared/al-contracts/al-carrier-capabilities.ts`;
modify the three carrier planners and their composition roots.

**Docs (Task 8):** the two ALM READMEs, the product description, the roadmap, the harness schema doc
and the observation artifact doc.

---

### Task 1: Purpose on the channel and the purpose table

**Files:**

- Create: `packages/shared/al-contracts/resolve-al-channel-send-defaults.ts`
- Create: `packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts`
- Create: `packages/shared-web/browser/messages/to-browser-message-send-defaults.ts`
- Modify: as "Purpose and defaults" above.
- Test: Create `packages/tests/shared/al-contracts/resolve-al-channel-send-defaults.test.ts`;
  modify `packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`,
  `packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts`,
  `packages/tests/shared-web/messages/browser-message-handle-admission.test.ts`,
  `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts` (direct sender calls),
  `packages/tests/shared-web/rooms/room-session.test.ts`.

**Interfaces:**

- Produces, in `resolve-al-channel-send-defaults.ts`:
  - `export type ALChannelPurpose = 'command' | 'notification';`
  - `export const AL_CHANNEL_PURPOSES: readonly ALChannelPurpose[]`
  - `export interface ALChannelSendDefaults { readonly reliability: 'at-least-once'; readonly ack: ALAckMode; readonly ttlMs: number; readonly durability: ALDurabilityAlgo; }`
  - `export const AL_CHANNEL_SEND_DEFAULTS: Readonly<Record<ALChannelPurpose, ALChannelSendDefaults>>`
  - `export interface ResolveALChannelSendDefaultsInput { readonly purpose: ALChannelPurpose; readonly durability: ALDurabilityAlgo | undefined; readonly hasLogicalAudience: boolean; }`
  - `export function resolveALChannelSendDefaults(input: ResolveALChannelSendDefaultsInput): ALChannelSendDefaults`
- Produces on `RallarTypedMessageChannelDefinition`: `readonly purpose: ALChannelPurpose` (required) and
  `readonly durability?: ALDurabilityAlgo` (absent = the purpose's, `volatile`); `RallarRoomMessageChannelDefinition`
  inherits both. `RallarTypedMessageSendStrategy = 'ws' | 'rtc' | 'ws-then-rtc' | 'rtc-with-ws-fallback'`.
- Produces `BrowserRallarMessageSender.sendRtc(input, channel)`, `sendWs(input, channel)`,
  `sendTyped(input, channel)` with `channel: RallarTypedMessageChannelDefinition | undefined`
  (`undefined` = a lane send, today's defaults).
- Produces `toBrowserMessageSendDefaults(input: ToBrowserMessageSendDefaultsInput): BrowserMessageSendDefaults`
  with `ToBrowserMessageSendDefaultsInput { send; channel; hasLogicalAudience; laneTtlMs }` and
  `BrowserMessageSendDefaults { ttlMs; reliability; ack; qos }`.
- Task 2 consumes `resolveALChannelSendDefaults` to build the default envelope in its RTC test; Task 3
  consumes the envelope's `qos.durability`; Task 6 consumes `durability` on the channel definition.

- [ ] **Step 1: RED — the purpose table.** Create `packages/tests/shared/al-contracts/resolve-al-channel-send-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import {
    AL_CHANNEL_PURPOSES,
    AL_CHANNEL_SEND_DEFAULTS,
    resolveALChannelSendDefaults
} from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('the channel purpose table (D2, D52)', () => {
    it('makes both purposes at-least-once, receipted, volatile and 30 s', () => {
        expect(AL_CHANNEL_PURPOSES).toEqual(['command', 'notification']);
        expect(AL_CHANNEL_SEND_DEFAULTS).toEqual({
            command: {
                reliability: 'at-least-once',
                ack: 'receiver',
                ttlMs: 30_000,
                durability: 'volatile'
            },
            notification: {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                ttlMs: 30_000,
                durability: 'volatile'
            }
        });
    });

    it('keeps the channel declared durability and drops the receipt where no logical audience exists', () => {
        expect(
            resolveALChannelSendDefaults({
                purpose: 'command',
                durability: 'local-outbox',
                hasLogicalAudience: true
            })
        )
            .toEqual({
                reliability: 'at-least-once',
                ack: 'receiver',
                ttlMs: 30_000,
                durability: 'local-outbox'
            });
        expect(
            resolveALChannelSendDefaults({
                purpose: 'notification',
                durability: undefined,
                hasLogicalAudience: false
            })
        )
            .toEqual({
                reliability: 'at-least-once',
                ack: 'none',
                ttlMs: 30_000,
                durability: 'volatile'
            });
    });

    it.each(AL_CHANNEL_PURPOSES)(
        'normalizes a %s default to receiver with a 2 s ACK timeout and three receipt retries',
        (purpose) => {
            const defaults = resolveALChannelSendDefaults({
                purpose,
                durability: undefined,
                hasLogicalAudience: true
            });
            const message = newALMulticastMessage(
                'self',
                { topicId: 'chat', resourceId: `purpose-${purpose}`, contextId: 'room' },
                ROOM,
                'chat.message.v1',
                { text: purpose },
                {
                    reliability: defaults.reliability,
                    ack: defaults.ack,
                    ttlMs: defaults.ttlMs,
                    qos: { durability: { algo: defaults.durability } }
                }
            );

            const { effective } = normalizeALQosPolicy(message);

            expect(effective.ack).toEqual({ algo: 'receiver', opts: { timeoutMs: 2_000 } });
            expect(effective.retry).toEqual({ algo: 'exp-backoff', opts: { maxAttempts: 3 } });
            expect(effective.durability.algo).toBe('volatile');
        }
    );
});
```

- [ ] **Step 2: RED — the channel stamps its purpose.** Append to the `describe('Rallar typed message channel', …)`
      block of `packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`:

```ts
it('builds a notification room send receipted, at-least-once and volatile with no options', async () => {
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
    const channel = createFacade().messages.room<ChatMessage>({
        topicId: 'room.chat',
        typeId: 'chat.message.v1',
        roomId: 'room-1',
        purpose: 'notification'
    });

    const handle = await channel.send({ text: 'default' }, { resourceId: 'purpose-default-1' });
    await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

    const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
    expect(message.delivery).toEqual({
        ownership: 'shared',
        reliability: 'at-least-once',
        ack: 'all-logical-recipients'
    });
    expect(message.qos?.durability).toEqual({ algo: 'volatile' });
    // The builder reads the clock once for the id and once for the deadline.
    expect(message.constraints?.expiresAtMs).toBeGreaterThanOrEqual(message.id.ts + 30_000);
    expect(message.constraints?.expiresAtMs).toBeLessThan(message.id.ts + 30_050);
});

it('asks the addressed receiver for a command and keeps the channel durability opt-in', async () => {
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
    const channel = createFacade().messages.room<ChatMessage>({
        topicId: 'room.command',
        typeId: 'room.command.v1',
        roomId: 'room-1',
        purpose: 'command',
        durability: 'local-outbox'
    });

    await channel.sendRtc({ text: 'command' }, { resourceId: 'purpose-command-1' });

    const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
    expect(message.delivery?.ack).toBe('receiver');
    expect(message.qos?.durability).toEqual({ algo: 'local-outbox' });
});

it('lets every per-send option override the purpose', async () => {
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
    const channel = createFacade().messages.room<ChatMessage>({
        topicId: 'room.chat',
        typeId: 'chat.message.v1',
        roomId: 'room-1',
        purpose: 'notification'
    });

    await channel.sendRtc({ text: 'override' }, {
        resourceId: 'purpose-override-1',
        reliability: 'best-effort',
        ack: 'none',
        ttlMs: 5_000,
        qos: { durability: { algo: 'local-inbox' } }
    });

    const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
    expect(message.delivery).toMatchObject({ reliability: 'best-effort', ack: 'none' });
    expect(message.qos?.durability).toEqual({ algo: 'local-inbox' });
    expect(message.constraints?.expiresAtMs).toBeGreaterThanOrEqual(message.id.ts + 5_000);
    expect(message.constraints?.expiresAtMs).toBeLessThan(message.id.ts + 5_050);
});

it('keeps no receipt on a world broadcast, whose audience A1 owns', async () => {
    const channel = createFacade().messages.channel<ChatMessage>({
        topicId: 'room.chat',
        typeId: 'chat.message.v1',
        purpose: 'notification'
    });

    await channel.sendWs({ text: 'everyone' }, { scope: 'all', resourceId: 'purpose-all-1' });

    const message = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0];
    expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'none' });
    expect(message.qos?.durability).toEqual({ algo: 'volatile' });
});

it('refuses a realtime, a missing or an unknown purpose and an unknown durability at the channel', () => {
    const facade = createFacade();
    const define = (definition: object) => () =>
        facade.messages.channel(definition as Parameters<typeof facade.messages.channel>[0]);

    expect(define({ typeId: 'chat.message.v1', purpose: 'realtime' })).toThrow(
        expect.objectContaining({
            issues: [expect.objectContaining({ path: '$.purpose', code: 'unsupported' })]
        })
    );
    expect(define({ typeId: 'chat.message.v1' })).toThrow(expect.objectContaining({
        issues: [expect.objectContaining({ path: '$.purpose', code: 'invalid-purpose' })]
    }));
    expect(define({ typeId: 'chat.message.v1', purpose: 'broadcast' })).toThrow(
        expect.objectContaining({
            issues: [expect.objectContaining({ path: '$.purpose', code: 'invalid-purpose' })]
        })
    );
    expect(define({ typeId: 'chat.message.v1', purpose: 'command', durability: 'forever' }))
        .toThrow(
            expect.objectContaining({
                issues: [
                    expect.objectContaining({ path: '$.durability', code: 'invalid-durability' })
                ]
            })
        );
});

it('retires the realtime send strategy', async () => {
    const channel = createFacade().messages.room<ChatMessage>({
        topicId: 'room.chat',
        typeId: 'chat.message.v1',
        roomId: 'room-1',
        purpose: 'notification'
    });

    await expect(channel.send({ text: 'x' }, { strategy: 'realtime' as never })).rejects
        .toMatchObject({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({ path: '$.strategy', code: 'unsupported' })]
        });
});
```

    Add `purpose: 'notification'` to every existing `messages.channel({…})`/`messages.room({…})`
    definition in this file (lines 87, 132, 144, 160, 166, 173, 185, 222, 253, 284, 325) and in
    `browser-rallar-message-sender.test.ts` (lines 61, 261, 277); the two invalid-definition tests at
    :130-178 keep their own failing fields and gain `purpose: 'notification'` so they still fail only
    on those fields.

- [ ] **Step 3: RED — the lane send and the WS unicast keep today's envelope.** Append to
      `browser-rallar-message-sender.test.ts` inside `describe('Rallar message send', …)`:

```ts
it('keeps a lane send on today\'s defaults: at-least-once, no receipt, no durability request', async () => {
    mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));
    const facade = createFacade();

    await facade.messages.rtc.send({
        roomId: 'room-1',
        typeId: 'chat.message.v1',
        payload: { text: 'lane' }
    });

    const message = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0];
    expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'none' });
    expect(message.qos).toBeUndefined();
});
```

    and to `packages/tests/shared-web/messages/browser-message-handle-admission.test.ts` (which drives
    the sender through `createBrowserMessageSenderFixture`):

```ts
it('keeps the director relay\'s WS unicast purpose-free and best-effort until S3c (D53, D60)', async () => {
    const fixture = createBrowserMessageSenderFixture();
    const envelope = vi.spyOn(fixture.middleware.webSocketQueueBox, 'enqueueOutboxIfAbsent');

    await fixture.sender.sendWsUnicast({
        peerId: 'director',
        typeId: 'director.intent.v1',
        payload: { intent: 'pickup' },
        route: { topicId: 'director.intent', contextId: 'room' }
    });

    expect(envelope.mock.calls[0][0].targets).toEqual({ mode: 'unicast', toPeerId: 'director' });
    expect(envelope.mock.calls[0][0].delivery).toBeUndefined();
    expect(envelope.mock.calls[0][0].qos).toBeUndefined();
});
```

    The same file's parametrized test at :24-30 calls `sendTyped`, `sendRtc` and `sendWs` directly:
    each gains `undefined` as the second argument (a lane-shaped send), as does every direct sender
    call in `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`
    (`rg -n "sender\.(sendTyped|sendRtc|sendWs)\(" packages/tests`).

- [ ] **Step 4: RED — the room shorthand is a notification.** Append to
      `packages/tests/shared-web/rooms/room-session.test.ts`:

```ts
it('gives a named room message the notification purpose and passes a declared one through', async () => {
    const { createRoomSession } = await import('@shared-web/browser/rooms/room-session.ts');
    const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
    const room = vi.fn();
    const session = createRoomSession({
        roomRef,
        stateStore: {} as Parameters<typeof createRoomSession>[0]['stateStore'],
        messages: { room } as unknown as Parameters<typeof createRoomSession>[0]['messages'],
        realtime: {} as Parameters<typeof createRoomSession>[0]['realtime'],
        leaveRoom: vi.fn(),
        refreshRoom: vi.fn(),
        createFormation: vi.fn()
    });

    session.message('chat');
    session.message({
        topicId: 'room.cmd',
        typeId: 'room.cmd.v1',
        purpose: 'command',
        durability: 'local-outbox'
    });

    expect(room.mock.calls.map(([definition]) => definition)).toEqual([
        { topicId: 'room.chat', typeId: 'room.chat.v1', roomRef, purpose: 'notification' },
        {
            topicId: 'room.cmd',
            typeId: 'room.cmd.v1',
            roomRef,
            purpose: 'command',
            durability: 'local-outbox'
        }
    ]);
});
```

    `message()` touches neither the state store nor the realtime facade, so empty doubles suffice;
    the assertion is on `room`'s arguments only.

- [ ] **Step 5: Run the RED tests.**

      Run: `npx vitest run packages/tests/shared/al-contracts/resolve-al-channel-send-defaults.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts packages/tests/shared-web/rooms/room-session.test.ts packages/tests/shared-web/messages/browser-message-handle-admission.test.ts`
      Expected: FAIL — the table module does not exist; the channel envelope has `ack: 'none'` and no
      `qos`; `purpose` is not validated; the `'realtime'` strategy sends over RTC.

- [ ] **Step 6: Implement the table.** Create `packages/shared/al-contracts/resolve-al-channel-send-defaults.ts`:

```ts
import type { ALAckMode } from './al-contract.ts';
import type { ALDurabilityAlgo } from './al-policy.ts';

/** What a typed channel carries; the purpose fixes the channel's send defaults (D2, D52). */
export type ALChannelPurpose = 'command' | 'notification';

export const AL_CHANNEL_PURPOSES: readonly ALChannelPurpose[] = ['command', 'notification'];

/**
 * The envelope fields a purpose decides. The 2 s ACK timeout and the three receipt retries of the
 * roadmap's table are the at-least-once normalization defaults these fields select.
 */
export interface ALChannelSendDefaults {
    readonly reliability: 'at-least-once';
    readonly ack: ALAckMode;
    readonly ttlMs: number;
    readonly durability: ALDurabilityAlgo;
}

/** `receiver` asks the addressed receiver; `all-logical-recipients` the frozen audience -- one algorithm (D41). */
export const AL_CHANNEL_SEND_DEFAULTS: Readonly<Record<ALChannelPurpose, ALChannelSendDefaults>> = {
    command: {
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 30_000,
        durability: 'volatile'
    },
    notification: {
        reliability: 'at-least-once',
        ack: 'all-logical-recipients',
        ttlMs: 30_000,
        durability: 'volatile'
    }
};

export interface ResolveALChannelSendDefaultsInput {
    readonly purpose: ALChannelPurpose;
    /** The channel's declared durability; absent, the purpose's. */
    readonly durability: ALDurabilityAlgo | undefined;
    /** A room multicast or room broadcast names a logical audience; a world or all broadcast does not (A1). */
    readonly hasLogicalAudience: boolean;
}

export function resolveALChannelSendDefaults(
    input: ResolveALChannelSendDefaultsInput
): ALChannelSendDefaults {
    const defaults = AL_CHANNEL_SEND_DEFAULTS[input.purpose];
    return {
        ...defaults,
        ack: input.hasLogicalAudience ? defaults.ack : 'none',
        durability: input.durability ?? defaults.durability
    };
}
```

- [ ] **Step 7: Implement the contracts, the validation and the envelope defaults.**

      In `rallar-message-contracts.ts`: import `ALChannelPurpose` from
      `@shared/al-contracts/resolve-al-channel-send-defaults.ts` and `ALDurabilityAlgo` beside
      `ALQosPolicyRequest`; line 8 becomes
      `export type RallarTypedMessageSendStrategy = 'ws' | 'rtc' | 'ws-then-rtc' | 'rtc-with-ws-fallback';`;
      lines 106-109 become:

```ts
export interface RallarTypedMessageChannelDefinition {
    readonly topicId?: string;
    readonly typeId: string;
    /** Fixes the send defaults (D2): at-least-once, receipted, volatile, 30 s; a send option overrides each. */
    readonly purpose: ALChannelPurpose;
    /** Absent, the purpose's `volatile`; `local-outbox`/`local-inbox` opt the channel into browser storage. */
    readonly durability?: ALDurabilityAlgo;
}
```

    Create `validate-rallar-typed-channel-policy.ts`:

```ts
import type { RallarTypedMessageChannelDefinition } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { AL_CHANNEL_PURPOSES } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

const AL_DURABILITIES: readonly unknown[] = ['volatile', 'local-outbox', 'local-inbox'];

/** A JavaScript caller can pass anything; a realtime purpose belongs to `rallar.realtime` (D15, D52). */
export function validateRallarTypedChannelPolicy(
    definition: Pick<RallarTypedMessageChannelDefinition, 'purpose' | 'durability'>
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    const purpose: unknown = definition.purpose;
    if (purpose === 'realtime') {
        issues.push({
            path: '$.purpose',
            code: 'unsupported',
            message:
                'A realtime channel belongs to rallar.realtime; a typed channel is a command or a notification.'
        });
    }
    else if (!AL_CHANNEL_PURPOSES.some((candidate) => candidate === purpose)) {
        issues.push({
            path: '$.purpose',
            code: 'invalid-purpose',
            message: 'Purpose must be command or notification.'
        });
    }
    if (definition.durability !== undefined && !AL_DURABILITIES.includes(definition.durability)) {
        issues.push({
            path: '$.durability',
            code: 'invalid-durability',
            message: 'Durability must be volatile, local-outbox or local-inbox.'
        });
    }
    return issues;
}
```

      In `browser-message-input-validator.ts:147-157` change the signature to
      `public validateTypedChannel(definition: RallarTypedMessageChannelDefinition): readonly RallarValidationIssue[]`,
      read `definition.topicId`/`definition.typeId` where it read the two parameters, and append
      `issues.push(...validateRallarTypedChannelPolicy(definition));` before `return issues;`.

      Create `to-browser-message-send-defaults.ts`:

```ts
import type {
    RallarMessageSendBase,
    RallarTypedMessageChannelDefinition
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALAckMode } from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import { resolveALChannelSendDefaults } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

export interface BrowserMessageSendDefaults {
    readonly ttlMs: number;
    readonly reliability: 'best-effort' | 'at-least-once';
    readonly ack: ALAckMode;
    readonly qos: ALQosPolicyRequest | undefined;
}

export interface ToBrowserMessageSendDefaultsInput {
    readonly send: RallarMessageSendBase<unknown>;
    /** Undefined for a lane send (`messages.rtc.send`, `messages.ws.send`), which keeps today's defaults. */
    readonly channel: RallarTypedMessageChannelDefinition | undefined;
    readonly hasLogicalAudience: boolean;
    readonly laneTtlMs: number;
}

/** Every send option wins over the channel's purpose; the purpose only fills what the send left out. */
export function toBrowserMessageSendDefaults(
    input: ToBrowserMessageSendDefaultsInput
): BrowserMessageSendDefaults {
    const { send, channel } = input;
    if (channel === undefined) {
        return {
            ttlMs: send.ttlMs ?? input.laneTtlMs,
            reliability: send.reliability ?? 'at-least-once',
            ack: send.ack ?? 'none',
            qos: send.qos
        };
    }
    const defaults = resolveALChannelSendDefaults({
        purpose: channel.purpose,
        durability: channel.durability,
        hasLogicalAudience: input.hasLogicalAudience
    });
    return {
        ttlMs: send.ttlMs ?? defaults.ttlMs,
        reliability: send.reliability ?? defaults.reliability,
        ack: send.ack ?? defaults.ack,
        qos: { ...send.qos, durability: send.qos?.durability ?? { algo: defaults.durability } }
    };
}
```

- [ ] **Step 8: Implement the sender and the channel.** In `browser-rallar-message-sender.ts`:
      `sendRtc<T>(input: RallarRtcSendInput<T>, channel: RallarTypedMessageChannelDefinition | undefined)`,
      `sendWs<T>(input: RallarWsSendInput<T>, channel: RallarTypedMessageChannelDefinition | undefined)`,
      `sendTyped<T>(input: BrowserRallarMessageSender.TypedInput<T>, channel: RallarTypedMessageChannelDefinition | undefined)`;
      `sendTyped`'s switch loses `case 'realtime':` and passes `channel` to `sendWs`, `sendRtc` and
      `sendRoomWithFallback(input, firstCarrier, channel)`; `CreateWsMessageInput` and
      `CreateRtcMessageInput` gain `readonly channel: RallarTypedMessageChannelDefinition | undefined`.
      In `createWsMessage` (:279-308) compute

```ts
const defaults = toBrowserMessageSendDefaults({
    send: input,
    channel,
    hasLogicalAudience: scope === 'room',
    laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
});
```

    and replace the four options `ttlMs`, `reliability`, `ack`, `qos` with `defaults.ttlMs`,
    `defaults.reliability`, `defaults.ack`, `defaults.qos`; do the same in `createRtcMessage` (:310-340)
    with `hasLogicalAudience: true` (every RTC typed send is a room multicast). `sendWsUnicast` is
    unchanged. In `browser-rallar-messages-controller.ts:81,88` pass `undefined` as the lane's channel.
    In `browser-typed-message-channels.ts`: `channel()` calls `validateTypedChannel(definition)`;
    `room()` calls `validateRoomChannel(definition)` and `validateTypedChannel(definition)`;
    `createChannel(definition)` keeps the whole `definition` and passes it as the second argument:

```ts
const route = { topicId: definition.topicId, typeId: definition.typeId };
return {
    send: async (payload, options: RallarTypedMessageSendOptions<T> = {}) =>
        await this.input.sender.sendTyped({ ...options, ...route, payload }, definition),
    sendRtc: async (payload, options: RallarTypedRtcSendOptions<T> = {}) =>
        await this.input.sender.sendRtc({ ...options, ...route, payload }, definition),
    sendWs: async (payload, options: RallarTypedWsSendOptions<T> = {}) =>
        await this.input.sender.sendWs({ ...options, ...route, payload }, definition),
    onRtc: (handler) =>
        this.input.rtc.onMessage<T>(route, async (message) => {
            await handler(message.payload, message);
        }),
    onWs: (handler) =>
        this.input.ws.onMessage<T>(route, async (message) => {
            await handler(message.payload, message);
        })
};
```

- [ ] **Step 9: Update every in-repo caller.**
      - `room-session.ts:85-110`: the string form returns
      `{ topicId: \`room.${input}\`, typeId: \`room.${input}.v1\`, roomRef, purpose: 'notification' }`;
        the object form returns`{ topicId: input.topicId, typeId: input.typeId, roomRef, purpose: input.purpose, ...(input.durability === undefined ? {} : { durability: input.durability }) }`.
      -`browser-director-relay-transport.ts:137`:`.room<RallarDirectorRelayEnvelope<T>>({ topicId: input.topicId, typeId: input.typeId, roomRef, purpose: 'notification' })`(the match lifecycle outputs go to the room audience).
      -`rallar-game-authority-client.ts:247-252`and`:297-302`: add`purpose: 'notification'`to both
        room definitions (commands, snapshots and presence are all room-audience envelopes; their
        explicit`reliability`/`ack`options still win).
      -`black-box-rallar-typed-channels.ts:48-53`: add`purpose: 'notification'`.
      -`docs/rallar-api-reference.md:612-615`: add`purpose: 'notification'`to the example, and one
        sentence after the block: "`purpose`is required:`command`asks the addressed receiver,`notification`the room's frozen audience; both are at-least-once, receipted, volatile and 30 s
        by default, and every send option overrides its default.`durability: 'local-outbox'`or`'local-inbox'`opts the channel into browser storage."
      -`packages/shared-web/architecture.md:101-108`: "`room.message('chat')`is a`notification`channel; the object form declares its own`purpose`."
      - Search once more:`rg -n -U "messages\s*\.\s*(room|channel)\s*(<[^>]_>)?\s_\(" packages apps docs examples .agents tests -g '_.ts' -g '_.tsx' -g '*.md'`— every hit declares a purpose or is`room.message('<name>')`.

- [ ] **Step 10: GREEN.** Run the Step 5 command. Expected: PASS. Then the per-task validation list,
      including `npm run test:repo-governance` (docs changed), the public API snapshot and both bundle
      tests; raise the facade ceiling to the next whole KiB if crossed, recording the measured figure
      in the test comment ("S3a's purpose table and channel policy validation measure N KiB").

- [ ] **Step 11: Commit.**

```bash
git add packages/shared/al-contracts/resolve-al-channel-send-defaults.ts packages/shared-web/browser/messages packages/shared-web/browser/rooms/room-session.ts packages/shared-web/browser/director/browser-director-relay-transport.ts packages/shared-web/game/authority/rallar-game-authority-client.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts docs/rallar-api-reference.md packages/shared-web/architecture.md packages/tests
git commit -m "feat(alm): a typed channel declares its purpose, and the purpose fixes the receipted, volatile default (D52)"
```

---

### Task 2: The receipted default reaches the handle

**Files:**

- Create: `packages/shared/alm/delivery/resolve-al-delivery-receipt-algo.ts`
- Modify: `packages/shared/alm/delivery/al-delivery-lifecycle.ts:222-287`,
  `packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts:151-157`
- Test: `packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts`,
  `packages/tests/shared-web/messages/browser-rallar-delivery-registry.test.ts`,
  `packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts`; the other
  `createInitialALDeliveryLifecycle` callers (`packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts:172`,
  `packages/tests/shared/alm/outbound-delivery-settlements.test.ts:109`,
  `packages/tests/shared/alm/outbound-admission-verdict.test.ts`, `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts:782,1800`).

**Interfaces:**

- Consumes Task 1's `resolveALChannelSendDefaults`.
- Produces `resolveALDeliveryReceiptAlgo(message: ALMessage): ALAckAlgo` — the effective ack algorithm
  of the envelope as normalized with no carrier (a requested `receiver` is kept, D42).
- Produces `ALDeliveryLifecycle.receiptAlgo: ALAckAlgo` and
  `CreateInitialALDeliveryLifecycleInput.receiptAlgo: ALAckAlgo` (both required). `isALDeliveryTerminal(lifecycle)`
  reads `receiptAlgo`; `isALDeliveryTerminalState(state, ackMode)` keeps its signature for callers that
  hold only a wire mode (`apps/ar-eye-hunter-v1/src/arena-ui/to-arena-labels.ts:108`).

- [ ] **Step 1: RED — terminality follows the tracked receipt.** Append to
      `compute-al-delivery-lifecycle.test.ts` inside `describe('transport-accepted terminality', …)`:

```ts
it.each([
    { receiptAlgo: 'none' as const, expectedTerminal: true },
    { receiptAlgo: 'hop' as const, expectedTerminal: false },
    { receiptAlgo: 'subtree' as const, expectedTerminal: false },
    { receiptAlgo: 'receiver' as const, expectedTerminal: false }
])(
    'ends at transport-accepted only when the tracked receipt is none (got $receiptAlgo)',
    ({ receiptAlgo, expectedTerminal }) => {
        const lifecycle = {
            ...createLifecycle('none'),
            state: 'transport-accepted' as const,
            receiptAlgo
        };

        expect(isALDeliveryTerminal(lifecycle)).toBe(expectedTerminal);
    }
);
```

    and make the file's `createLifecycle`/`createExpiringLifecycle` pass
    `receiptAlgo: ackMode === 'none' ? 'none' : 'receiver'`.

- [ ] **Step 2: RED — the registry derives it from the effective policy.** In
      `browser-rallar-delivery-registry.test.ts`, extend the first `open` test with
      `expect(handle.lifecycle().receiptAlgo).toBe('receiver');` and append inside `describe('record', …)`:

```ts
it('keeps a receipt requested only through qos.ack open past transport acceptance', () => {
    const harness = new DeliveryRegistryHarness();
    const handle = harness.registry.open(
        { ...toBestEffortTestMessage('msg-1'), qos: { ack: { algo: 'hop' } } },
        'rtc'
    );

    harness.registry.record(toAdmittedSettlement('msg-1', START_MS));
    harness.registry.record(toAttemptStartedSettlement('msg-1', START_MS));
    harness.registry.record(toAttemptSentSettlement('msg-1', START_MS));

    expect(handle.lifecycle()).toMatchObject({
        state: 'transport-accepted',
        ackMode: 'none',
        receiptAlgo: 'hop'
    });
    expect(isALDeliveryTerminal(handle.lifecycle())).toBe(false);
});
```

    (import `isALDeliveryTerminal` from `@shared/alm/delivery/al-delivery-lifecycle.ts`).

- [ ] **Step 3: Run.** `npx vitest run packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts packages/tests/shared-web/messages/browser-rallar-delivery-registry.test.ts`
      Expected: FAIL — `receiptAlgo` does not exist; the qos-only receipt is terminal.

- [ ] **Step 4: Implement.** Create `resolve-al-delivery-receipt-algo.ts`:

```ts
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, type ALAckAlgo } from '../../al-contracts/al-policy.ts';

/**
 * The receipt a handle waits for, read from the envelope's effective policy rather than its
 * `delivery.ack` alone, so a receipt requested only through `qos.ack` keeps the handle open.
 */
export function resolveALDeliveryReceiptAlgo(message: ALMessage): ALAckAlgo {
    return normalizeALQosPolicy(message).effective.ack.algo;
}
```

    In `al-delivery-lifecycle.ts`: add `readonly receiptAlgo: ALAckAlgo;` after `ackMode` in
    `ALDeliveryLifecycle` (doc: "The receipt the send's effective policy tracks; `none` makes
    `transport-accepted` terminal.") and in `CreateInitialALDeliveryLifecycleInput`; copy it in
    `createInitialALDeliveryLifecycle`; change `isALDeliveryTerminal`:

```ts
export function isALDeliveryTerminal(lifecycle: ALDeliveryLifecycle): boolean {
    return AL_DELIVERY_TERMINAL_STATES.includes(lifecycle.state) ||
        (lifecycle.state === 'transport-accepted' && lifecycle.receiptAlgo === 'none');
}
```

    and doc `isALDeliveryTerminalState`: "For a caller that knows only the wire mode." In
    `browser-rallar-delivery-registry.ts:151-157` add
    `receiptAlgo: resolveALDeliveryReceiptAlgo(message),` beside `ackMode`. Add `receiptAlgo` to every
    other `createInitialALDeliveryLifecycle` call listed under Files (`'none'` where `ackMode` is
    `'none'`, else `'receiver'`).

- [ ] **Step 5: RED→GREEN — the carry R-S2c-ii-5a dissolves for a default send.** Append to
      `web-rtc-overlay-frozen-audience.test.ts` inside `describe('RTC frozen room audience', …)`:

```ts
it('settles a default notification send as rejected by the hop whose resync-required NACK it admits', async () => {
    const fixture = createFixture();
    const defaults = resolveALChannelSendDefaults({
        purpose: 'notification',
        durability: undefined,
        hasLogicalAudience: true
    });
    const message = newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId: 'default-relay-rejected', contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: 'default' },
        {
            reliability: defaults.reliability,
            ack: defaults.ack,
            ttlMs: defaults.ttlMs,
            qos: { durability: { algo: defaults.durability } }
        }
    );
    await enqueueAndDrain(fixture.manager, message);

    const admitted = await fixture.manager.acceptControlMessage(newALNackControlMessage(
        { v: 2, msgId: 'nack-resync-from-b', senderId: 'b', ts: Date.now() },
        {
            msgId: message.id.msgId,
            fromPeerId: 'b',
            toPeerId: 'a',
            reason: 'resync-required',
            observedAtEpochMs: Date.now()
        }
    ));
    await vi.advanceTimersByTimeAsync(0);

    expect(admitted.kind).toBe('committed');
    expect(fixture.settlements).toContainEqual(expect.objectContaining({
        kind: 'relay-rejected',
        msgId: message.id.msgId,
        relayRejection: { relay: 'peer', peerId: 'b', reason: 'resync-required' }
    }));
});

it('still leaves an explicit receipt-less send without a committed hop NACK (the carry stays for explicit ack none)', async () => {
    const fixture = createFixture();
    const message = newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId: 'receipt-less', contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: 'none' },
        { reliability: 'at-least-once', ack: 'none', ttlMs: 30_000 }
    );
    await enqueueAndDrain(fixture.manager, message);

    const admitted = await fixture.manager.acceptControlMessage(newALNackControlMessage(
        { v: 2, msgId: 'nack-resync-receipt-less', senderId: 'b', ts: Date.now() },
        {
            msgId: message.id.msgId,
            fromPeerId: 'b',
            toPeerId: 'a',
            reason: 'resync-required',
            observedAtEpochMs: Date.now()
        }
    ));

    expect(admitted.kind).not.toBe('committed');
});
```

    (imports: `newALMulticastMessage` from `@shared/al-contracts/al-contract.ts`,
    `resolveALChannelSendDefaults` from `@shared/al-contracts/resolve-al-channel-send-defaults.ts`,
    `ORIGIN_ROOM` from `./rtc-origin-overlay-fixture.ts`). Both pass once Task 1 lands; the first is
    the verification the carry names and must pass here without a product change beyond Task 1.

- [ ] **Step 6: GREEN.** `npx vitest run packages/tests/shared/alm/delivery packages/tests/shared-web/messages packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/alm/outbound-admission-verdict.test.ts packages/tests/shared-web/director`
      Expected: PASS. Then the per-task validation list (public API snapshot: `ALDeliveryLifecycle`
      gains a field — no export name changes).

- [ ] **Step 7: Commit.**

```bash
git add packages/shared/alm/delivery packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts packages/tests tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
git commit -m "feat(alm): the handle waits for the receipt its effective policy tracks, so the default send is receipted end to end"
```

---

### Task 3: Durability decoupled from retry

**Files:**

- Modify: `packages/shared/al-contracts/al-policy.ts:388-395`,
  `packages/shared/al-contracts/normalize-al-qos-policy.ts:179-181,273-276`,
  `packages/shared/services/ws-queue-box-client-service.ts:274`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts:15,95`,
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:608,673-676`.
- Harness `durability` on `messages.send`, all nine registries together:
  `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:300-319`,
  `packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts:95-110,288`,
  `packages/shared-test/rallar-bb-test/schema.ts:593-610`,
  `packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts:79-99`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts:26-55,90-110`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:279-298`,
  `black-box-rallar-typed-channels.ts:15-19,48-53`, `black-box-rallar-delivery-ledger.ts:91`,
  `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts:11-17`,
  `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md:153`.
- Conformance: `alm-conformance-message-commands.ts:25-34,121-150`, `scenarios/delivery-reload.ts:111-122`,
  `scenarios/delivery-lifecycle.ts:137,160`, `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (regenerated).
- Test: `packages/tests/shared/al-policy.test.ts`, `packages/tests/shared/ws-qos-policy.test.ts`,
  `packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts`,
  `packages/tests/shared/multicast-policy-integration.test.ts:314-369`,
  `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`,
  `packages/tests/shared-test/alm-conformance-recipes.test.ts`.

**Interfaces:**

- Produces `shouldPersistOutbox(effective): boolean` = durability is `local-outbox` or `local-inbox`
  (the sender's copy persists); `shouldPersistInbox` unchanged (`local-inbox`).
- Produces `shouldAwaitALRoute(effective: ALQosEffectivePolicy): boolean` = durability above
  `volatile` or retry not `none`: an admission that may wait for a route instead of being refused.
- Normalization: a message that requests no durability is `volatile` whatever its reliability.
- Produces the harness field `durability?: 'volatile' | 'local-outbox' | 'local-inbox'` on
  `messages.send`, carried to the typed channel definition; `AlmConformanceSendDelivery.durability`;
  `toRetainedEvidenceCommands(step, durable: boolean)`.
- Tasks 4 and 5 route by `plan.persist` / the envelope's durability; Task 6 consumes the harness field.

- [ ] **Step 1: RED — the policy.** Append to `packages/tests/shared/al-policy.test.ts`:

```ts
describe('durability decoupled from retry (S3a)', () => {
    const route = { topicId: 'chat', resourceId: 'decoupled', contextId: 'room' };
    const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

    it('normalizes an at-least-once message that requests no durability to volatile, still retrying and waiting for a route', () => {
        const message = newALMulticastMessage('self', route, room, 'chat.message.v1', {}, {
            reliability: 'at-least-once',
            ack: 'receiver'
        });

        const { effective } = normalizeALQosPolicy(message);

        expect(effective.durability.algo).toBe('volatile');
        expect(effective.retry.algo).toBe('exp-backoff');
        expect(shouldPersistOutbox(effective)).toBe(false);
        expect(shouldAwaitALRoute(effective)).toBe(true);
    });

    it.each([
        { algo: 'volatile' as const, outbox: false, inbox: false },
        { algo: 'local-outbox' as const, outbox: true, inbox: false },
        { algo: 'local-inbox' as const, outbox: true, inbox: true }
    ])('honours a requested $algo: outbox $outbox, inbox $inbox', ({ algo, outbox, inbox }) => {
        const message = newALMulticastMessage('self', route, room, 'chat.message.v1', {}, {
            reliability: 'at-least-once',
            qos: { durability: { algo } }
        });

        const { effective } = normalizeALQosPolicy(message);

        expect(effective.durability.algo).toBe(algo);
        expect(shouldPersistOutbox(effective)).toBe(outbox);
        expect(shouldPersistInbox(effective)).toBe(inbox);
    });

    it('lets a best-effort volatile message be refused for lacking a route', () => {
        const message = newALMulticastMessage('self', route, room, 'chat.typing.v1', {});

        expect(shouldAwaitALRoute(normalizeALQosPolicy(message).effective)).toBe(false);
    });
});
```

    (imports from `@shared/al-contracts/al-contract.ts` and `@shared/al-contracts/al-policy.ts`).

- [ ] **Step 2: RED — the carriers.** Append to `ws-qos-policy.test.ts` inside its `describe`:

```ts
it('admits an at-least-once send that requests no durability as volatile, even while the socket is closed', async () => {
    const socket = createFakeWsSocket();
    const service = shared.createDefaultWsQueueBoxClientService({
        outbox: new shared.InMemoryQueueBox(new Map()),
        socket: socket.client,
        sessionId: 'self'
    }).enableDefaultCallbacks();
    onTestFinished(() => service.close());
    const msg = shared.newALBroadcastMessage(
        'self',
        { topicId: 'chat', resourceId: 'msg-volatile-closed', contextId: 'all' },
        'all',
        'chat.message.v1',
        { text: 'later' },
        { reliability: 'at-least-once', ttlMs: 30_000 }
    );

    socket.native.readyState = 3;
    const result = await enqueueOutboxAndDrain(service, msg);

    expect(result.verdict).toMatchObject({ kind: 'admitted', durable: false });
    expect(socket.sentJsonStrings).toEqual([]);
});
```

    and to `ws-queue-box-server-outbound-planning.test.ts` one guard (green before and after, the
    server's meaning must not move): an at-least-once room broadcast with
    `qos: { durability: { algo: 'volatile' } }` plans `persist: true` at phase `immediate` with no
    prepared messages (recipients resolve at dequeue), built with the file's existing planning
    fixture exactly as its other `persist` cases are.

- [ ] **Step 3: Run.** `npx vitest run packages/tests/shared/al-policy.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts`
      Expected: FAIL — durability normalizes to `local-outbox`, `shouldAwaitALRoute` does not exist,
      the closed-socket send reads `durable: true`.

- [ ] **Step 4: Implement the policy.** In `al-policy.ts` replace `shouldPersistOutbox` (:392-395) with:

```ts
/** The sender keeps its copy in browser storage exactly when the channel chose a durability above volatile. */
export function shouldPersistOutbox(effective: ALQosEffectivePolicy): boolean {
    return effective.durability.algo !== 'volatile';
}

/**
 * An admission that may wait for a route instead of being refused for lacking one: a message that
 * retries or persists. This is what `shouldPersistOutbox` meant before S3a; the WS server's recipient
 * resolution and the RTC missing-channel check keep that meaning.
 */
export function shouldAwaitALRoute(effective: ALQosEffectivePolicy): boolean {
    return effective.durability.algo !== 'volatile' || effective.retry.algo !== 'none';
}
```

    In `normalize-al-qos-policy.ts` delete the `durability:` entry of `toALQosPolicyRequest`
    (:179-181), so a message requests durability only through `msg.qos`, and make the default at
    :273-276 `durability: { algo: 'volatile', opts: {} },`. `alignRequestedDurability` is left
    unchanged: it never raises durability above the request (see "Rulings to take before execution").

- [ ] **Step 5: Implement the carriers.** `ws-queue-box-client-service.ts:274` becomes
      `persist: shouldPersistOutbox(normalized.effective),` — a volatile send made while the socket is
      closed stays with its owner and goes when the socket opens ("Reliable volatile delivery survives a
      dropped connection while its runtime lives", roadmap "Purpose at the channel"); crash survival is
      the durable opt-in. `ws-queue-box-server-outbound-planning.ts:95` becomes
      `const persist = shouldAwaitALRoute(normalized.effective);` (import swapped at :15).
      `web-rtc-overlay-multicast-manager.ts:608` becomes `persist: shouldPersistOutbox(effective),`, and
      :674 becomes `if (shouldAwaitALRoute(plan.handlingPlan.effective)) {` (import both from
      `../al-contracts/al-policy.ts`).

- [ ] **Step 6: The harness field, in all nine registries.**
      - contracts `RallarBlackBoxTestMessagesSendCommand`: `durability?: 'volatile' | 'local-outbox' | 'local-inbox';`
      - `rallar-black-box-command-fields.ts`: `'durability'` in `messages.send` `optional`; field values
      `messagesDurability: ['volatile', 'local-outbox', 'local-inbox'],`
      - `schema.ts` `messages.send`: `durability: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesDurability },`
      - `validate-alm-control-command.ts` ordinary send:
      `...validateEnumField({ record: command, key: 'durability', path, allowed: values.messagesDurability }),`
      - `decode-black-box-rallar-message-send-input.ts`: `'durability'` in `REPLAY_REFUSED_FIELDS` and in
      `MessageSendOptions`; decode `const durability = record.durability ?? undefined;` against
      `MESSAGE_DURABILITIES = ['volatile', 'local-outbox', 'local-inbox']`, refusing an unknown value
      with `'messages.send.durability must be volatile, local-outbox or local-inbox.'`.
      - `BlackBoxRallarMessageSendInput`: `readonly durability: ALDurabilityAlgo | undefined;`
      - `TypedChannelRoute`: `readonly durability: ALDurabilityAlgo | undefined;`, and `open()` adds
      `...(route.durability === undefined ? {} : { durability: route.durability })` to the definition;
      `subscribe()` passes `durability: undefined`; the ledger's `open(config, { …, durability: send.durability })`.
      - capability text: append "durability (volatile, local-outbox, local-inbox) declares the typed
      channel's durability; absent, the send is volatile."
      - `schema-and-capabilities.md:153` paragraph: the same sentence.

      Add to `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`:

```ts
it('decodes a declared send durability and refuses an unknown one', () => {
    const send = {
        kind: 'messages.send',
        timeoutMs: 1_000,
        connection: 'sender',
        carrier: 'ws',
        typeId: 'alm.conformance',
        handleId: 'handle-1',
        payload: { n: 1 }
    };

    expect(decodeBlackBoxRallarMessageSendInput({ ...send, durability: 'local-outbox' }).right)
        .toMatchObject({ durability: 'local-outbox' });
    expect(decodeBlackBoxRallarMessageSendInput(send).right).toMatchObject({
        durability: undefined
    });
    expect(decodeBlackBoxRallarMessageSendInput({ ...send, durability: 'forever' }).left)
        .toEqual({
            message: 'messages.send.durability must be volatile, local-outbox or local-inbox.'
        });
});
```

- [ ] **Step 7: The conformance scenarios keep their meaning.** `AlmConformanceSendDelivery` gains
      `readonly durability?: 'local-outbox' | 'local-inbox';`. `toRetainedEvidenceCommands(step, durable)`
      asserts `enqueued` equals `durable` (the verdict's `durable` flag is the store choice now).
      `delivery-reload.ts` `toReloadOriginalSend` adds `durability: 'local-outbox'` (its reload survival
      is the durable opt-in) and calls `toRetainedEvidenceCommands({ ...sender, index: 1 }, true)`;
      `delivery-lifecycle.ts:137,160` call it with `false` (the default path is volatile; the held send
      is still retained, accepted or queued and unsubmitted). Add to `alm-conformance-recipes.test.ts`:

```ts
it('opts the reload original into local-outbox and reads the lifecycle specimens as volatile', () => {
    for (const carrier of ALM_CONFORMANCE_CARRIERS) {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const reload = scenarios.find((scenario) => scenario.scenarioId === 'delivery-reload')!;
        const lifecycle = scenarios.find((scenario) =>
            scenario.scenarioId === 'delivery-lifecycle'
        )!;
        const reloadSend = reload.sender.commands.find((command) =>
            command.kind === 'messages.send'
        );
        const enqueuedAsserts = (recipe: RallarBlackBoxTestRecipe) =>
            recipe.commands.filter((command) =>
                command.kind === 'assert' && command.source.endsWith('.value.enqueued')
            );

        expect(reloadSend, carrier).toMatchObject({ durability: 'local-outbox' });
        expect(enqueuedAsserts(reload.sender).map((command) => command.expected), carrier).toEqual([
            true
        ]);
        expect(enqueuedAsserts(lifecycle.sender).map((command) => command.expected), carrier)
            .toEqual([false, false]);
    }
});
```

- [ ] **Step 8: Move the carrier pins that encoded "at-least-once implies durable".** Run
      `npx vitest run packages/tests/shared packages/tests/shared-web packages/tests/shared-test packages/shared-rtc-bench/tests`.
      Each red that asserts `durable: true` / `admittedDurable: true` for a message that requests no
      durability is one of two kinds, and only these two edits are allowed:
      (a) the test is about the admission verdict of an ordinary send → the expectation becomes
      `durable: false` (`multicast-policy-integration.test.ts` "admits durable multicast actions before
      native submission", :314-369, whose message is `reliability: 'at-least-once', ack: 'group-leader'`
      — rename it "admits a volatile at-least-once multicast before native submission");
      (b) the test is about durable recovery or durable storage → the message gains
      `qos: { durability: { algo: 'local-outbox' } }` (for example `rtc-durable-owner-recovery.test.ts:345-357`,
      `ws-durable-owner-recovery.test.ts:104-107,196-199,421-429` if they turn red here; they certainly
      turn red in Task 4). List every moved pin with its kind in the commit body. A red of any other
      shape is a defect of this task — stop and diagnose it.

- [ ] **Step 9: GREEN.** Run the Step 3 command, `npx vitest run packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared/ws-server-qos-policy.test.ts`,
      then `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts` and the manifest
      test, then the per-task validation list (Deno checks: `packages/shared` and `packages/shared-test`
      changed), `npm run test:api-v1:black-box:memory` (the server planner line), and the smoke lane.

- [ ] **Step 10: Commit.**

```bash
git add packages/shared/al-contracts/al-policy.ts packages/shared/al-contracts/normalize-al-qos-policy.ts packages/shared/services packages/shared/multicast/web-rtc-overlay-multicast-manager.ts packages/shared-test apps/rallar-black-box/manifests packages/tests
git commit -m "feat(alm): durability is its own choice -- volatile unless a channel opts in, decoupled from retry"
```

---

### Task 4: Two store lanes per outbound runtime

**Files:**

- Create: `packages/shared/alm/outbound/al-outbound-send-controls.ts`,
  `packages/shared/alm/outbound/al-outbound-store-lane.ts`
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (the constructor body :347-417,
  `enqueueIfAbsent` :481-503, `retransmitAdmittedMessage` :505-520, `enqueueAllIfAbsent` :522-549,
  `acceptControlMessage`/`acceptReceipt` :551-572, `commitDispatchPlan` :574-584 and the work methods
  :611-778 move into the lane; `cancel`, `emitSettlement` and the routing stay),
  `create-default-al-outbound-message-runtime.ts:32-39,87-118`, `packages/shared/alm/al-runtime-stores.ts`,
  `packages/shared/alm/al-admission-backend.ts:63-80`, `packages/shared/alm/ALStoreRetention.ts`,
  `packages/shared/alm/delivery/al-delivery-lifecycle.ts:294-301`,
  `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`,
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts:58-80`,
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts:48-73`,
  `packages/shared/services/ws-queue-box-client-service.ts:120-137,650-655`.
- Test: `packages/tests/shared/alm/outbound-runtime-test-fixture.ts`, `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`,
  `packages/tests/shared/al-outbound-message-runtime.test.ts`, `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`,
  and the tests that drive the browser composition's stores: `packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts`,
  `packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts`,
  `packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts`,
  `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts`,
  `packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts`.

**Interfaces:**

- Produces in `al-outbound-message-runtime.ts`:
  `export interface ALVolatileOutboundRuntimeStores<TPrepared> extends ALOutboundRuntimeStores<TPrepared> { evictExpired(): void; }`
  and `ALOutboundMessageRuntime.Resources.volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined`
  (required; `undefined` = one backend for every admission — the server, the tests that do not opt in).
  `admissionStore`/`workQueue` stay the durable pair, so `dependencies.outboundRuntime.admissionStore`
  readers (`ws-queue-box-server-service.ts:166`) do not move.
- Produces `createVolatileALOutboundRuntimeStores<TPrepared>(options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>): ALVolatileOutboundRuntimeStores<TPrepared>`
  in `al-runtime-stores.ts`, and `InMemoryAdmissionBackend.evictExpired(): void`.
- Produces `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS = 60_000` in `ALStoreRetention.ts` (the cadence of
  `BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS`).
- Produces `createBrowserALVolatileOutboundRuntimeStores(name: string): ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>`
  in `browser-al-runtime-stores.ts` (always memory; namespace `browser:${name}:volatile`).
- Produces `DefaultALOutboundRuntimeResourceInput.volatileStores?` and
  `WsQueueBoxClientService.Input.outboundVolatileStores?`.
- Routing rules (the runtime's, stated in its class doc):
  - an admission (`enqueueIfAbsent`, each member of `enqueueAllIfAbsent`) goes to the lane its plan's
    `persist` names — the plan is computed once and handed to the lane's admission for the same
    message, so the admission never plans the message twice;
  - a group whose members differ in durability commits as one group per lane (no cross-store
    atomicity; no caller mixes today — ACK batches are all volatile);
  - a control, a receipt and a retransmission go to the volatile lane when it owns the target msgId
    (`hasSentMessageAdmission`, a memory read), else to the durable lane;
  - `cancel(msgId)` is runtime-wide (one `ALOutboundSendControls`);
  - only the durable lane admits foreign dequeue rows (`dequeue.types`); the volatile lane names none
    and takes no browser lock (Web Locks guard cross-tab IndexedDB commits; memory is per tab);
  - the volatile lane's worker id is `${effectWorkerId}/volatile`;
  - the volatile lane calls `evictExpired()` from its `selectReady`, at most once per
    `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` of its clock.

- [ ] **Step 1: RED — a volatile send spends no IndexedDB operation.** In
      `al-indexeddb-operation-counts.test.ts`, extract the durable pin's store construction (:198-216) into

```ts
function createIndexedDbOutboundCountStores(
    observer: IndexedDbOperationObserver,
    name: string
): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${name}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: name,
            decodePrepared: decodeOutboundTestPayload,
            namespace: name,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}
```

    use it in the existing pin (renamed "sends one durable message in 10 al-admission and 15 al-work
    operations"; its planner already says `persist: true`, figures unchanged), and append:

```ts
describe('outbound volatile send IndexedDB volume', () => {
    it('sends one volatile message beside a durable pair in 0 al-admission and 0 non-probe al-work operations', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundCountStores(observer, 'outbound-volatile-send'),
            volatileStores: createVolatileALOutboundRuntimeStores({
                decodePrepared: decodeOutboundTestPayload
            }),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => {
                sent.push('send');
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await runtime.ready();
        observer.reset();

        const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage('msg-volatile-send'));
        expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: false });
        // The volatile lane's own commit runs its batch, as in production. `runOutboundWorkTask` would
        // also run the idle durable lane's batch directly, a claim the engine never makes without a
        // due probe answer.
        await vi.waitFor(() => expect(sent).toEqual(['send']));

        const counts = observer.getCounts();
        // S3a (D55): a volatile default leaves nothing in IndexedDB; only the idle durable owner's
        // readiness probes (work-page) may read it.
        expect(counts.byOwner['al-admission'], 'a volatile send commits nothing to IndexedDB').toBe(
            0
        );
        expect(
            counts.byOwner['al-work'] - (counts.byKind['work-page'] ?? 0),
            'no non-probe al-work operation'
        ).toBe(0);
        runtime.dispose();
    });
});
```

- [ ] **Step 2: RED — routing and eviction.** Move `trackAcks` and the v2 ACK construction of
      `outbound-delivery-settlements.test.ts` (:120-122 and the `newALAckControlMessage` call at :231-245)
      into `outbound-runtime-test-fixture.ts` as `trackOutboundTestAcks(expectedPeerIds)` and
      `toOutboundTestAck(message, fromPeerId)` (the settlements test imports them), then append to
      `packages/tests/shared/al-outbound-message-runtime.test.ts`:

```ts
describe('outbound store lanes (S3a, D54)', () => {
    function planVolatileSend(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
        return {
            msg,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [{ kind: 'send' }]
        };
    }

    it('admits a durable plan to the durable pair and a volatile plan to the memory pair', async () => {
        const durable = createDefaultOutboundTestStores();
        const volatileStores = createVolatileOutboundTestStores();
        const fleeting = createOutboundMessage('fleeting');
        const kept = createOutboundMessage('kept');
        const runtime = createDefaultOutboundTestRuntime({
            stores: durable,
            volatileStores,
            planOutgoingMessage: (msg) => ({
                ...planVolatileSend(msg),
                persist: msg.id.msgId === kept.id.msgId
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        await enqueueOutboundOrThrow(runtime, fleeting);
        await enqueueOutboundOrThrow(runtime, kept);

        expect(await volatileStores.admissionStore.hasSentMessageAdmission(fleeting.id.msgId)).toBe(
            true
        );
        expect(await durable.admissionStore.hasSentMessageAdmission(fleeting.id.msgId)).toBe(false);
        expect(await durable.admissionStore.hasSentMessageAdmission(kept.id.msgId)).toBe(true);
        expect(await volatileStores.admissionStore.hasSentMessageAdmission(kept.id.msgId)).toBe(
            false
        );
    });

    it('routes an acknowledgement to the lane that owns its message', async () => {
        const durable = createDefaultOutboundTestStores();
        const volatileStores = createVolatileOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores: durable,
            volatileStores,
            planOutgoingMessage: (msg) => ({
                ...planVolatileSend(msg),
                ackTracking: trackOutboundTestAcks(['peer-1'])
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('acknowledged-in-memory');
        await enqueueOutboundOrThrow(runtime, message);

        const admitted = await runtime.acceptControlMessage(
            toOutboundTestAck(message, 'peer-1'),
            'peer'
        );

        expect(admitted.kind).toBe('committed');
        expect(
            await volatileStores.admissionStore.readPendingAck({
                originPeerId: 'self',
                msgId: message.id.msgId
            })
        )
            .toBeUndefined();
        expect(await durable.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
    });

    it('evicts its expired rows on the first round past the eviction interval, with no timer of its own', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => vi.useRealTimers());
        const volatileStores = createVolatileOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            volatileStores,
            planOutgoingMessage: planVolatileSend,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        await enqueueOutboundOrThrow(runtime, createOutboundMessage('expiring', { ttlMs: 1_000 }));
        expect((await volatileStores.workQueue.getAllKeys()).length).toBeGreaterThan(0);

        vi.setSystemTime(Date.now() + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS + 1_000);
        await runOutboundWorkTask(runtime);

        expect(await volatileStores.workQueue.getAllKeys()).toEqual([]);
    });
});
```

    (A completed receipt deletes its pending row, so `readPendingAck` reads `undefined` once the ACK
    committed in the lane that owns the message.)

- [ ] **Step 3: Run.** `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts`
      Expected: FAIL — `volatileStores` and `createVolatileALOutboundRuntimeStores` do not exist.

- [ ] **Step 4: Implement the memory pair and its eviction.** In `ALStoreRetention.ts`:

```ts
/** How often a volatile lane sweeps its memory pair, on its own work round -- the IndexedDB eviction's cadence. */
export const AL_VOLATILE_STORE_EVICTION_INTERVAL_MS = 60_000;
```

    In `InMemoryAdmissionBackend` (`al-admission-backend.ts`):

```ts
/** The lazy expiry `read` and `list` apply, run over the whole pair; the owning lane calls it. */
evictExpired(): void {
    const nowMs = this.nowMs();
    for (const [key, stored] of this.state.data) {
        if (stored.expireAtTimestamp <= nowMs) {
            this.state.data.delete(key);
        }
    }
    this.workQueue.cleanup();
}
```

    In `al-runtime-stores.ts`:

```ts
/** The memory pair a browser carrier routes volatile admissions to; it persists nothing. */
export function createVolatileALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>
): ALVolatileOutboundRuntimeStores<TPrepared> {
    const input = toDefaultInMemoryInput(options);
    const backend = new InMemoryAdmissionBackend(
        createInMemoryALAdmissionState(
            new InMemoryQueueBox(
                undefined,
                () => Temporal.Instant.fromEpochMilliseconds(input.nowMs())
            )
        ),
        input.nowMs
    );
    const stores = createInMemoryALOutboundRuntimeStores({
        ...input,
        outboundBackend: backend,
        decodePrepared: options.decodePrepared
    });
    return { ...stores, evictExpired: () => backend.evictExpired() };
}
```

- [ ] **Step 5: Extract the send controls.** Create `al-outbound-send-controls.ts` holding, verbatim,
      `cancelledMsgIds`, `liveMessageSendControllers`, `sendAbortController` and the methods
      `acquireMessageSendSignal`, `releaseMessageSendAttemptWhenSettled`, `releaseMessageSendSignal` of
      the runtime (:341-344, :732-766), as:

```ts
export class ALOutboundSendControls {
    get signal(): AbortSignal;
    /** Remembers the id for the owner's lifetime and aborts a live attempt; the caller states the settlement. */
    cancel(msgId: string): ALOutboundCancelOutcome;
    isCancelled(msgId: string): boolean;
    acquire(msgId: string): AbortSignal;
    releaseWhenSettled(msgId: string, result: ALWorkAttemptResult): void;
    release(msgId: string): void;
    /** Aborts every live message controller, then the owner-wide signal. */
    dispose(): void;
}
```

    (bodies moved unchanged; `ALOutboundCancelOutcome` moves with it and is re-exported from the
    runtime file's existing export).

- [ ] **Step 6: Extract the lane.** Create `al-outbound-store-lane.ts` with the per-store half of the
      runtime moved unchanged — the construction of `workPort`, `controlAdmission`, `dispatchAdmission`,
      `repairAdmission`, `receiptAdmission`, `repairRetransmission`, `work`, `effects` (:348-411) and
      `commitDispatchPlan`, `hasWrittenWork`, `selectOutboundWork`, `readDequeueDeferral`,
      `runOutboundClaim`, `readExpirableOutboundWork`, `hasReachedDeadline`, `readOutboundWork`,
      `runDurableEffect`, `isCancelledEffect`, `runPreparedSend`, `emitWorkExpiry`, `recordWorkDiagnostics`,
      `readNowMs`, `statesMessageDeadline`, `resolveALOutboundEffectMsgId` (:574-891) — reading the
      store pair, worker id, dequeue types and browser locks from its own input instead of the runtime's
      dependencies, and the cancelled set and live controllers through `sendControls`:

```ts
export namespace ALOutboundStoreLane {
    export interface Input<TPrepared> {
        readonly stores: ALOutboundRuntimeStores<TPrepared>;
        readonly workerId: string;
        /** Foreign queue rows only the durable lane admits; the volatile lane names none. */
        readonly dequeueTypes: ReadonlySet<string>;
        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
        /** The memory pair's sweep; undefined for a lane over a durable pair. */
        readonly evictExpired: (() => void) | undefined;
        readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
        readonly sendControls: ALOutboundSendControls;
        readonly settlements: ALOutboundSettlementEmitter;
    }
}

export class ALOutboundStoreLane<TPrepared> {
    constructor(input: ALOutboundStoreLane.Input<TPrepared>);
    ready(): Promise<void>;
    dispose(): void;
    /** A memory read on the volatile lane: whether this lane admitted the message. */
    ownsMessage(msgId: string): Promise<boolean>;
    commit(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>>;
    commitAll(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly ALOutboundComputedDto<TPrepared>[]>;
    acceptControlMessage(
        msg: ALMessage,
        source: ALOutboundControlSource
    ): Promise<ALOutboundControlAdmissionResult>;
    acceptReceipt(control: ALMessage): Promise<ALOutboundControlAdmissionResult>;
}
```

    `ownsMessage` is `this.input.stores.admissionStore.hasSentMessageAdmission(msgId)`.
    `selectOutboundWork` starts with the eviction check:

```ts
private evictWhenDue(): void {
    const nowMs = this.readNowMs();
    if (this.input.evictExpired === undefined || nowMs < this.nextEvictionAtMs) {
        return;
    }
    this.nextEvictionAtMs = nowMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS;
    this.input.evictExpired();
}
```

- [ ] **Step 7: The runtime becomes the router.** In `al-outbound-message-runtime.ts` add
      `readonly volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined;` to `Resources`,
      and replace the constructor body and the moved methods with:

```ts
    constructor(dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        const settlements: ALOutboundSettlementEmitter = (fact) => this.emitSettlement(fact);
        this.durable = new ALOutboundStoreLane({
            stores: dependencies,
            workerId: dependencies.effectWorkerId,
            dequeueTypes: dependencies.dequeue.types,
            browserLocks: dependencies.browserLocks,
            evictExpired: undefined,
            runtime: dependencies,
            sendControls: this.sendControls,
            settlements
        });
        this.volatile = dependencies.volatileStores === undefined ? undefined : new ALOutboundStoreLane({
            stores: dependencies.volatileStores,
            workerId: `${dependencies.effectWorkerId}/volatile`,
            dequeueTypes: new Set<string>(),
            browserLocks: undefined,
            evictExpired: dependencies.volatileStores.evictExpired,
            runtime: dependencies,
            sendControls: this.sendControls,
            settlements
        });
    }

    async enqueueIfAbsent(
        msg: ALMessage,
        dispatchPlan?: ALOutboundDispatchPlan<TPrepared>
    ): Promise<ALOutboundEnqueueResult> {
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }
        await this.ready();
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }
        const plan = dispatchPlan ?? this.dependencies.planOutgoingMessage(msg);
        const computed = await this.selectLaneForPlan(plan).commit({
            msg,
            planner: toPlannedOnce(msg, plan, this.dependencies.planOutgoingMessage),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: { explicitPlan: dispatchPlan !== undefined }
        });
        return ALOutboundMessageRuntime.toEnqueueResult(computed, msg);
    }

    /** The lane a durable plan names, or the only lane of a runtime with one backend. */
    private selectLaneForPlan(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundStoreLane<TPrepared> {
        return plan.persist || this.volatile === undefined ? this.durable : this.volatile;
    }

    /** A memory read, so a control about a volatile message never reaches IndexedDB. */
    private async selectLaneForMessage(msgId: string): Promise<ALOutboundStoreLane<TPrepared>> {
        return this.volatile !== undefined && await this.volatile.ownsMessage(msgId) ? this.volatile : this.durable;
    }
```

    with the module-private

```ts
/** The plan the router already made for this message, so its admission does not plan it twice. */
function toPlannedOnce<TPrepared>(
    planned: ALMessage,
    plan: ALOutboundDispatchPlan<TPrepared>,
    planner: ALOutboundPlanner<TPrepared>
): ALOutboundPlanner<TPrepared> {
    return (msg, admittedAudience) =>
        msg === planned && admittedAudience === undefined ? plan : planner(msg, admittedAudience);
}
```

    `enqueueAllIfAbsent` plans each message once, partitions the dispatches by
    `selectLaneForPlan`, calls `commitAll` per lane and returns the results in the input order.
    `retransmitAdmittedMessage`, `acceptControlMessage` and `acceptReceipt` select the lane with
    `selectLaneForMessage` over `retransmission.msg.id.msgId`, the control's target
    (`controlTargetMsgId(decodeALControlMessage(msg).right!)` from
    `./compute-al-outbound-control-admission.ts`; an undecodable control goes to the durable lane,
    which answers `not-handled` as today), and the receipt's `payload.msgId`. `ready()` awaits both
    lanes; `dispose()` disposes both and `sendControls`; `cancel(msgId)` calls
    `sendControls.cancel(msgId)` and emits the `cancelled` settlement when it returns `cancelled`;
    `sendSignal` returns `sendControls.signal`. Update the class doc with the routing rules of this
    task's Interfaces block.

- [ ] **Step 8: Composition.** `createDefaultALOutboundRuntimeResources` takes
      `readonly volatileStores?: ALVolatileOutboundRuntimeStores<TPrepared>` and returns
      `volatileStores: input.volatileStores`. In `browser-al-runtime-stores.ts`:

```ts
/** Always memory, whatever the browser supports: the pair a carrier routes volatile admissions to. */
export function createBrowserALVolatileOutboundRuntimeStores(
    name: string
): ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createVolatileALOutboundRuntimeStores({
        namespace: `browser:${name}:volatile`,
        decodePrepared: decodeALOutboundTransportMessage
    });
}
```

    `WsQueueBoxClientService.Input` gains `readonly outboundVolatileStores?: ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>;`,
    passed as `volatileStores` at :650-655; `createBrowserWebSocketQueueBoxService` passes
    `outboundVolatileStores: createBrowserALVolatileOutboundRuntimeStores(toBrowserWsClientALRuntimeStoreId(clientData.sessionId))`;
    `initialiseRtcOverlayMulticastManager` passes
    `volatileStores: createBrowserALVolatileOutboundRuntimeStores(toBrowserRtcOverlayALRuntimeStoreId(webRtcConnectionService.input.sessionId))`
    to `createDefaultALOutboundRuntimeResources`. The WS server's resources keep `volatileStores: undefined`.
    Doc of `hasALDeliveryDurableWork`: "A non-durable `admitted` verdict wrote its rows to the volatile
    pair, whose owner the commit already woke."

- [ ] **Step 9: Fixtures and the durable-recovery tests.** In `outbound-runtime-test-fixture.ts`:
      `OutboundTestRuntimeInput` gains `readonly volatileStores?: ALVolatileOutboundRuntimeStores<TPrepared>;`
      passed through `createOutboundTestRuntimeFor`; export
      `createVolatileOutboundTestStores(): ALVolatileOutboundRuntimeStores<OutboundTestPayload>` =
      `createVolatileALOutboundRuntimeStores({ decodePrepared: decodeOutboundTestPayload })`;
      `createOutboundRuntimeWithWorkTask` records every `al-outbound:` registration in order and
      `runOutboundWorkTask` runs them all in that order (durable lane first);
      `captureOutboundWorkRunnable` does the same. Every literal `ALOutboundMessageRuntime.Resources`
      that `npm run typecheck:tests` names gains `volatileStores: undefined`. The durable-recovery tests
      (`rtc-durable-owner-recovery.test.ts`, `ws-durable-owner-recovery.test.ts`) run the browser
      composition and so now have a volatile lane: each original they recover from IndexedDB gains
      `qos: { durability: { algo: 'local-outbox' } }` — a recovery test is a durable opt-in; the
      signaling message at `ws-durable-owner-recovery.test.ts:286` stays as it is (volatile). The other
      three store-driving files listed under Files take the same two edit kinds as Task 3 Step 8 if
      they turn red (a verdict pin becomes volatile; a test about retained IndexedDB work opts in), and
      nothing else.
      Add to the browser stores test:

```ts
it('gives every carrier a fresh, empty memory pair that shares nothing with IndexedDB', async () => {
    const first = createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1');
    const second = createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1');

    expect(first.workQueue).toBeInstanceOf(InMemoryQueueBox);
    expect(second.workQueue).not.toBe(first.workQueue);
    expect(await second.workQueue.getAllKeys()).toEqual([]);
});
```

- [ ] **Step 10: GREEN.** `npx vitest run packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/multicast packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared-web/al-runtime packages/tests/shared-web/rtc packages/tests/shared-web/websocket packages/tests/shared-test/rallar-browser-runtime`
      Expected: PASS, with the durable pin still 10 + 15 and the volatile pin 0 + 0. Then the per-task
      validation list, the smoke lane and both bundle ceilings (record the measured figures).

- [ ] **Step 11: Commit.**

```bash
git add packages/shared/alm packages/shared/services/ws-queue-box-client-service.ts packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts packages/tests
git commit -m "feat(alm): each outbound carrier runtime holds a memory and an IndexedDB store lane and routes every admission by its durability (D54)"
```

---

### Task 5: Two store lanes for the inbound session store

**Files:**

- Create: `packages/shared/alm/inbound/al-inbound-store-lane.ts`,
  `packages/shared/alm/inbound/resolve-al-inbound-store-durability.ts`,
  `packages/shared/alm/inbound/control/is-al-origin-acknowledgement.ts`
- Modify: `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (constructor :165-208, `ready`,
  `dispose`, `recordWorkDiagnostics`…`recordEmptyRotationRound` :251-325, `retainConflictedAdmission`
  :385-396, `admitControlMessage` :398-419, `commitWork`, the claim and effect methods :431-576 move into
  the lane; `admitIncomingMessage`, `admitDecodedMessage`, `recordAdmissionOutcome` stay and route),
  `create-default-al-inbound-message-runtime.ts:11-55`, `packages/shared/alm/al-runtime-stores.ts`,
  `packages/shared/services/web-rtc-rx-streamer-service.ts:55-63,489-497`,
  `packages/shared/services/ws-queue-box-client-service.ts:130,644-649`,
  `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`,
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts:25-40,76-80`,
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts:80-125`,
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts:163-201,241-256,312-321`.
- Test: `packages/tests/shared/alm/inbound-runtime-test-fixture.ts`, `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`,
  create `packages/tests/shared/alm/inbound/resolve-al-inbound-store-durability.test.ts`.

**Interfaces:**

- Consumes Task 3's `shouldPersistInbox` and Task 4's `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS`,
  `InMemoryAdmissionBackend.evictExpired`.
- Produces `export type ALStoreDurability = 'volatile' | 'durable';` and
  `resolveALInboundStoreDurability(msg: ALMessage): ALStoreDurability` — `durable` exactly when the
  envelope's normalized durability is `local-inbox`.
- Produces `isALOriginAcknowledgement(msg: ALMessage, selfPeerId: string): boolean` — an ACK v2 whose
  `originPeerId` is this peer: the origin holds no inbound decision surface for its own message, so the
  inbound control admission answers `not-handled` without a read (it answered the same after an
  IndexedDB read before S3a).
- Produces `ALVolatileInboundRuntimeStores extends ALInboundRuntimeStores { evictExpired(): void; }`,
  `ALInboundMessageRuntime.Resources.volatileStores: ALVolatileInboundRuntimeStores | undefined` (required),
  `createVolatileALInboundRuntimeStores(options?: CreateDefaultALRuntimeStoresInput): ALVolatileInboundRuntimeStores`,
  `createBrowserALVolatileInboundRuntimeStores(name: string): ALVolatileInboundRuntimeStores`,
  `DefaultALInboundRuntimeResourceInput.volatileStores?`, `WsQueueBoxClientService.Input.inboundVolatileStores?`,
  `WebRtcRxStreamerService.Input.inboundVolatileStores?`, `CreateBrowserWebSocketQueueBox.Input.inboundVolatileStores`,
  `InitialiseRtcRxStreamerInput.inboundVolatileStores`.
- Routing rules: a data message goes to the lane `resolveALInboundStoreDurability(msg)` names; an ACK
  control this peer originated is `not-handled` with no read; any other control goes to the volatile
  lane first and, when that lane answers `not-handled`, to the durable lane; the volatile lane's worker
  id is `${effectWorkerId}/volatile` and it evicts on its rotation round like the outbound lane.
- Session end, storage reset, cleanup: the inbound memory pair is created once in `initialiseMiddleware`
  and handed to both carriers (D20); it dies with the middleware. `browser-al-runtime-cleanup.ts` stays
  IndexedDB-only — session cleanup has nothing in memory to reach, and a storage reset (schema
  mismatch) touches only IndexedDB, so it is a no-op for volatile work.

- [ ] **Step 1: RED — the durability rule.** Create `packages/tests/shared/alm/inbound/resolve-al-inbound-store-durability.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import { resolveALInboundStoreDurability } from '@shared/alm/inbound/resolve-al-inbound-store-durability.ts';

function toMessage(durability: ALDurabilityAlgo | undefined) {
    return newALUnicastMessage(
        'sender',
        { topicId: 'chat', resourceId: `durability-${durability ?? 'none'}`, contextId: 'room' },
        'receiver',
        'chat.message.v1',
        {},
        {
            ttlMs: 30_000,
            qos: durability === undefined ? undefined : { durability: { algo: durability } }
        }
    );
}

describe('resolveALInboundStoreDurability', () => {
    it.each([
        { durability: undefined, expected: 'volatile' },
        { durability: 'volatile' as const, expected: 'volatile' },
        { durability: 'local-outbox' as const, expected: 'volatile' },
        { durability: 'local-inbox' as const, expected: 'durable' }
    ])(
        'stores a message that carries $durability in the $expected inbound pair',
        ({ durability, expected }) => {
            expect(resolveALInboundStoreDurability(toMessage(durability))).toBe(expected);
        }
    );
});
```

- [ ] **Step 2: RED — the inbound volume.** In `inbound-runtime-test-fixture.ts`,
      `CreateInboundTestRuntimeInput` gains `readonly volatileStores?: ALVolatileInboundRuntimeStores;`
      (passed to `createDefaultALInboundRuntimeResources`), `InboundTestMessageInput` gains
      `readonly durability?: ALDurabilityAlgo;` (merged into `toInboundTestQos` as
      `durability: { algo: input.durability }`), and `INBOUND_TEST_SELF_PEER_ID` is exported. In
      `al-indexeddb-operation-counts.test.ts`, let `readAdmittedInboundDelivery` take
      `(input: Readonly<{ volatile: boolean; durability: ALDurabilityAlgo | undefined }>)`, create the
      runtime with `volatileStores: input.volatile ? createVolatileALInboundRuntimeStores({ namespace: \`${INBOUND_NAMESPACE}-volatile\` }) : undefined`,
      the message with`durability: input.durability`, settle on the queue of the lane the message went
      to (`runInboundRotationUntilSettled(fixture, workQueue)`), and return the non-probe`al-work`count
      beside the admission count. The existing two tests call it with`{ volatile: false, durability: undefined }`
      (still 8). Append:

```ts
it('admits and delivers one volatile message beside a durable pair in 0 admission and 0 non-probe work operations', async () => {
    const admitted = await readAdmittedInboundDelivery({ volatile: true, durability: undefined });

    expect(admitted.acceptance).toEqual({ kind: 'admitted' });
    expect(admitted.delivered).toEqual(['dispatched']);
    // S3a (D55): the volatile default admits to the memory pair.
    expect(admitted.admissionOperations).toBe(0);
    expect(admitted.nonProbeWorkOperations).toBe(0);
});

it('still admits a local-inbox message beside a volatile pair in 8 admission operations', async () => {
    expect(
        (await readAdmittedInboundDelivery({ volatile: true, durability: 'local-inbox' }))
            .admissionOperations
    ).toBe(8);
});

it('answers an acknowledgement of its own message without reading any store', async () => {
    const observer = createCountingIndexedDbOperationObserver();
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: INBOUND_NAMESPACE,
            storage: 'indexeddb',
            observer
        }),
        effectWorkerId: INBOUND_WORKER_ID
    });
    await fixture.runtime.ready();
    observer.reset();

    const admitted = await fixture.runtime.admitIncomingMessage(
        newALAckControlMessage(
            {
                v: 2,
                msgId: 'ack-own-message',
                senderId: INBOUND_TEST_SENDER_PEER_ID,
                ts: Date.now()
            },
            {
                ackedMsgId: 'own-message',
                fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
                toPeerId: INBOUND_TEST_SELF_PEER_ID,
                originPeerId: INBOUND_TEST_SELF_PEER_ID,
                logicalRecipientPeerId: INBOUND_TEST_SENDER_PEER_ID,
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: Date.now()
            }
        ),
        INBOUND_TEST_SOURCE
    );

    expect(admitted.right).toEqual({ kind: 'control', handled: false });
    expect(observer.getCounts().byOwner['al-admission']).toBe(0);
});
```

- [ ] **Step 3: Run.** `npx vitest run packages/tests/shared/alm/inbound/resolve-al-inbound-store-durability.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
      Expected: FAIL — the resolver, the volatile inbound pair and the origin short-circuit do not exist
      (the own-ACK case reads the store today).

- [ ] **Step 4: Implement the rules.** Create `resolve-al-inbound-store-durability.ts`:

```ts
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { normalizeALQosPolicy, shouldPersistInbox } from '../../al-contracts/al-policy.ts';

export type ALStoreDurability = 'volatile' | 'durable';

/**
 * The sending channel's declared durability, carried as the envelope's `qos.durability`, decides the
 * inbound store: only `local-inbox` keeps the receiver's copy. No receiver-side policy moves it.
 */
export function resolveALInboundStoreDurability(msg: ALMessage): ALStoreDurability {
    return shouldPersistInbox(normalizeALQosPolicy(msg).effective) ? 'durable' : 'volatile';
}
```

    Create `control/is-al-origin-acknowledgement.ts`:

```ts
import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../../al-contracts/al-control.ts';

/** The origin of a message keeps no inbound decision surface for it, so its own acknowledgements are outbound's. */
export function isALOriginAcknowledgement(msg: ALMessage, selfPeerId: string): boolean {
    const control = decodeALControlMessage(msg).right;
    return control?.type === 'ack' && control.payload.originPeerId === selfPeerId;
}
```

    `createVolatileALInboundRuntimeStores` in `al-runtime-stores.ts` mirrors Task 4's outbound one over
    `createInMemoryALInboundRuntimeStores({ ...input, inboundBackend: backend })`.

- [ ] **Step 5: Extract the lane and route.** Create `al-inbound-store-lane.ts` with the per-store half
      of the runtime moved unchanged (the listed members, including the rotation diagnostics state
      `emptyRoundCount`, `emptyRoundsFromMs`, `longestEmptyRoundMs`, `deferredRoundCount`,
      `latestDeferred`, `batchRunOrder`, `controlRound`):

```ts
export namespace ALInboundStoreLane {
    export interface Input {
        readonly stores: ALInboundRuntimeStores;
        readonly workerId: string;
        /** The memory pair's sweep; undefined for a lane over a durable pair. */
        readonly evictExpired: (() => void) | undefined;
        readonly runtime: ALInboundMessageRuntime.Dependencies;
    }
}

export class ALInboundStoreLane {
    constructor(input: ALInboundStoreLane.Input);
    ready(): Promise<void>;
    dispose(): void;
    admitData(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>>;
    admitControl(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundControlAdmissionResult>;
}
```

    `admitData` is today's tail of `admitDecodedMessage` after the control branch (attempt, conflict
    retention, `commitWork`); `admitControl` is today's `controlAdmission.admit` plus `commitWork` on
    `pending-control`/`committed`. The lane's `selectReady` wraps the work selector's with the same
    `evictWhenDue()` as the outbound lane. The runtime keeps `validateALInboundMessage`, the ready and
    disposed checks, and routes:

```ts
if (isALControlTypeId(msg.payload.typeId)) {
    return Either.ofRight(await this.admitControlMessage(msg, source));
}
return await this.selectDataLane(msg).admitData(msg, source, planIncomingMessage);
```

```ts
    private selectDataLane(msg: ALMessage): ALInboundStoreLane {
        return this.volatile === undefined || resolveALInboundStoreDurability(msg) === 'durable'
            ? this.durable
            : this.volatile;
    }

    /** Memory first, so a control about a volatile message never reaches IndexedDB. */
    private async admitControlMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundMessageRuntime.Acceptance> {
        const selfPeerId = this.dependencies.effectPreparation.selfPeerId;
        const admitted = isALOriginAcknowledgement(msg, selfPeerId)
            ? { kind: 'not-handled' as const }
            : await this.admitControlInLanes(msg, source);
        if (admitted.kind === 'pending-control') {
            return { kind: 'pending-admission' };
        }
        const acceptance: ALControlAcceptance = admitted.kind === 'committed'
            ? admitted.acceptance
            : { handled: false, completedPendingAcks: [] };
        if (!this.disposed) {
            await this.dependencies.onControlMessage?.(msg, acceptance);
        }
        return { kind: 'control', handled: acceptance.handled };
    }

    private async admitControlInLanes(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundControlAdmissionResult> {
        const volatile = await this.volatile?.admitControl(msg, source);
        return volatile === undefined || volatile.kind === 'not-handled'
            ? await this.durable.admitControl(msg, source)
            : volatile;
    }
```

    (the volatile lane is constructed exactly as Task 4's: `workerId: \`${dependencies.effectWorkerId}/volatile\``,
    `evictExpired: dependencies.volatileStores.evictExpired`).

- [ ] **Step 6: Composition.** `createDefaultALInboundRuntimeResources` takes and returns
      `volatileStores` (`input.volatileStores`); `browser-al-runtime-stores.ts`:

```ts
export function createBrowserALVolatileInboundRuntimeStores(
    name: string
): ALVolatileInboundRuntimeStores {
    return createVolatileALInboundRuntimeStores({ namespace: `browser:${name}:volatile` });
}
```

    `initialiseMiddleware` creates `const inboundVolatileStores = createBrowserALVolatileInboundRuntimeStores(toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId));`
    after `inboundStores`, adds it to `InitialiseBrowserTransportInput`, and passes it to
    `createBrowserWebSocketQueueBox` (→ `inboundVolatileStores` → the WS client's
    `createDefaultALInboundRuntimeResources`) and `initialiseRtcRxStreamer` (→
    `createDefaultWebRtcRxStreamerService` → its `createDefaultALInboundRuntimeResources`). One pair,
    both carriers (D20); the WS server keeps `volatileStores: undefined`. Every literal
    `ALInboundMessageRuntime.Resources` `npm run typecheck:tests` names gains `volatileStores: undefined`.

- [ ] **Step 7: GREEN.** `npx vitest run packages/tests/shared/alm packages/tests/shared/webrtc-rx-streamer-service.test.ts packages/tests/shared/webrtc-rx-policy.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared-web packages/tests/shared-test`
      Expected: PASS; the durable inbound pin still 8, the volatile one 0. Then the per-task validation
      list, the smoke lane and both bundle ceilings.

- [ ] **Step 8: Commit.**

```bash
git add packages/shared/alm packages/shared/services packages/shared-web/browser packages/tests
git commit -m "feat(alm): the session's inbound store is a memory and an IndexedDB lane shared by both carriers, routed by the carried durability (D20, D54)"
```

---

### Task 6: The volatile proof

**Files:**

- Create: `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/volatile-default.ts`,
  `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/durable-opt-in.ts`
- Modify: `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts:51-55`,
  `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts:148-160`,
  `packages/shared-test/rallar-bb-test/alm/browser-adapter-alm-commands.ts:280-292`,
  `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts:207-214`,
  `alm-conformance-scenario-definition.ts:18-27`, `create-alm-conformance-recipes.ts:30-76`,
  `scenarios/delivery-baseline.ts:57-67`, `alm-observation-snapshot.ts:35-38,232-239`,
  `compute-alm-observation-regime.ts:320-336`, `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:52-54`
  (description), the regenerated `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`,
  `packages/tests/shared/alm/al-storage-snapshot.test.ts`.
- Test: create `packages/tests/shared-test/alm-conformance-storage-window.test.ts`; modify
  `packages/tests/shared-test/alm-conformance-recipes.test.ts:128-152,296-330,541-566`,
  `packages/tests/shared-test/alm-observation-regime.test.ts`.

**Interfaces:**

- Consumes Task 3's `durability` send field, Tasks 4–5's lanes.
- Produces on `RallarBlackBoxTestStorageCountersResultValue`: `readonly workProbeCount: number`
  (`byKind['work-page']`), `readonly workNonProbeCount: number` (`byOwner['al-work'] - workProbeCount`)
  and `readonly reset: boolean` (whether this reading reset the counter after reading it);
  `decodeAlmStorageCountersResultValue(value: unknown, reset: boolean)`.
- Produces `toStorageCountersCommand(step, name, reset: boolean)`.
- Produces `AlmConformanceScenarioId` members `'volatile-default' | 'durable-opt-in'`; the scenario
  order `[volatileDefault, boundedRejection, deadlineExpiry, deliveryBaseline, deliveryLifecycle, durableOptIn, deliveryReload, orderingResync, …]`
  — `volatile-default` runs first on its pages, before any scenario leaves durable work there.
- Produces `ALMObservationStorageCounters { atEpochMs; agentId; workPageCount; reset }` and a
  reset-aware work-page rate: per agent, a reading's increment is its count minus the previous reading's
  count, or its whole count after a reset; the rate is the increments' sum over the span. With no reset
  it equals today's `last − first` (the fixture pin stays 3.15/s).

- [ ] **Step 1: RED — the counters and the scenarios.** Create `packages/tests/shared-test/alm-conformance-storage-window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { decodeAlmStorageCountersResultValue } from '@shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts';
import type { RallarBlackBoxTestStorageCountersResultValue } from '@shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

function toCounters(
    input: Readonly<{ admission: number; work: number; workPages: number; }>
): RallarBlackBoxTestStorageCountersResultValue {
    return decodeAlmStorageCountersResultValue({
        total: input.admission + input.work,
        byOwner: { 'al-admission': input.admission, 'al-work': input.work },
        byKind: {
            read: input.admission,
            'work-page': input.workPages,
            'work-reserve': input.work - input.workPages
        }
    }, false);
}

async function runStorageWindow(
    recipe: RallarBlackBoxTestRecipe,
    window: RallarBlackBoxTestStorageCountersResultValue
): Promise<boolean> {
    const commands = recipe.commands.filter((command) =>
        command.kind === 'storage.counters' ||
        (command.kind === 'assert' && command.source.includes('storage-window'))
    );
    const runtime = createRallarBlackBoxTestRuntime({
        commandExecutor: (command) =>
            command.kind === 'storage.counters' ? { status: 'ok', value: window } : undefined
    });
    return (await runtime.execute({ kind: 'recipe.run', recipe: { ...recipe, commands } })).ok;
}

describe('storage counter window', () => {
    it('splits the probe reads from every other work operation', () => {
        expect(toCounters({ admission: 0, work: 5, workPages: 3 })).toMatchObject({
            workProbeCount: 3,
            workNonProbeCount: 2,
            reset: false
        });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'pins zero admission and zero non-probe work on both volatile-default pages over %s',
        async (carrier) => {
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier)).find((
                candidate
            ) => candidate.scenarioId === 'volatile-default')!;
            for (const recipe of [scenario.sender, scenario.receiver]) {
                const opening = recipe.commands.find((command) =>
                    command.kind === 'storage.counters'
                );
                expect(opening, recipe.recipeId).toMatchObject({ reset: true });
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 0, work: 4, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(true);
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 1, work: 4, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(false);
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 0, work: 5, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(false);
            }
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'requires admission operations on both durable-opt-in pages over %s',
        async (carrier) => {
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier)).find((
                candidate
            ) => candidate.scenarioId === 'durable-opt-in')!;
            const send = scenario.sender.commands.find((command) =>
                command.kind === 'messages.send'
            );
            expect(send).toMatchObject({ durability: 'local-inbox' });
            for (const recipe of [scenario.sender, scenario.receiver]) {
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 3, work: 4, workPages: 1 })
                    ),
                    recipe.recipeId
                ).toBe(true);
                expect(
                    await runStorageWindow(
                        recipe,
                        toCounters({ admission: 0, work: 4, workPages: 4 })
                    ),
                    recipe.recipeId
                ).toBe(false);
            }
        }
    );
});
```

    `toConformanceInput` and its `group` constant are what `alm-conformance-recipes.test.ts` defines at
    :29 and :46-57; move both into `packages/tests/shared-test/alm-conformance-test-input.ts` (export
    `toConformanceInput`) and import it from both files. In
    `alm-conformance-recipes.test.ts`: `SCENARIO_KEYS_BY_CARRIER` gains `'volatile-default'` first and
    `'durable-opt-in'` after `'delivery-lifecycle'` for every carrier; the smoke list at :301 becomes
    `['volatile-default', 'bounded-rejection', 'deadline-expiry', 'delivery-baseline', 'delivery-lifecycle', 'durable-opt-in']`;
    the tags list at :320 gains two `['smoke', 'full']` entries in those positions; the test at :541
    ("requires positive storage evidence in the delivery baseline") is deleted — the durable-opt-in
    test above replaces it — and one assertion is added that `delivery-baseline`'s sender has no
    `assert` over `.value.total`. In `alm-observation-regime.test.ts` add:

```ts
it('sums the work-page increments across a counter reset instead of reading the reset as negative', () => {
    const regime = toSyntheticRegimeWithStorageCounters([
        { atEpochMs: 0, agentId: 'alm-sender-1', workPageCount: 10, reset: false },
        { atEpochMs: 10_000, agentId: 'alm-sender-1', workPageCount: 30, reset: true },
        { atEpochMs: 20_000, agentId: 'alm-sender-1', workPageCount: 5, reset: false }
    ]);

    expect(regime.workPageRate).toEqual({
        outcome: 'measured',
        perSecond: 1.25,
        readingCount: 3,
        spanMs: 20_000
    });
});
```

    with the helper beside the file's `toCommitPhaseEvent` (:62-82):

```ts
function toSyntheticRegimeWithStorageCounters(
    readings: readonly Readonly<
        { atEpochMs: number; agentId: string; workPageCount: number; reset: boolean; }
    >[]
): ALMObservationRegime {
    return toSyntheticRegime(readings.map((reading) => ({
        kind: 'diagnostic',
        atEpochMs: reading.atEpochMs,
        agentId: reading.agentId,
        payload: {
            topic: 'rallar.bb.storage.counters',
            payload: {
                data: { byKind: { 'work-page': reading.workPageCount }, reset: reading.reset }
            }
        }
    })));
}
```

    (Expected 1.25/s: the second reading adds 20 pages, the third 5 counted from the reset, over 20 s.)

- [ ] **Step 2: Run.** `npx vitest run packages/tests/shared-test/alm-conformance-storage-window.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-observation-regime.test.ts`
      Expected: FAIL — no such scenarios, no derived counters, the reset reads as −25 pages.

- [ ] **Step 3: Implement the counters.** `decodeAlmStorageCountersResultValue(value, reset)` returns
      `{ total, byOwner, byKind, workProbeCount, workNonProbeCount, reset }` with
      `workProbeCount = byKind['work-page'] ?? 0` and `workNonProbeCount = byOwner['al-work'] - workProbeCount`;
      `readAlmStorageCounters` passes `counters.reset === true`. `toStorageCountersCommand(step, name, reset)`
      sets `reset`; its existing callers pass `false`. `alm-observation-snapshot.ts` reads `agentId` and
      `reset` (`decodeBoolean(diagnostic.detail.reset) ?? false`); `computeWorkPageRate` groups by agent:

```ts
function computeWorkPageRate(
    readings: readonly ALMObservationStorageCounters[]
): ALMObservationWorkPageRate {
    const ordered = [...readings].sort((left, right) => left.atEpochMs - right.atEpochMs);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === undefined || last === undefined || last.atEpochMs <= first.atEpochMs) {
        return { outcome: 'too-few-readings', readingCount: ordered.length };
    }
    const spanMs = last.atEpochMs - first.atEpochMs;
    return {
        outcome: 'measured',
        perSecond: toTwoDecimals(computeWorkPageIncrements(ordered) / (spanMs / 1000)),
        readingCount: ordered.length,
        spanMs
    };
}

/** Each agent counts from its own previous reading, or from zero after a reading that reset the counter. */
function computeWorkPageIncrements(ordered: readonly ALMObservationStorageCounters[]): number {
    const previousByAgent = new Map<string, ALMObservationStorageCounters>();
    let increments = 0;
    for (const reading of ordered) {
        const previous = previousByAgent.get(reading.agentId);
        if (previous !== undefined) {
            increments += reading.workPageCount - (previous.reset ? 0 : previous.workPageCount);
        }
        previousByAgent.set(reading.agentId, reading);
    }
    return increments;
}
```

- [ ] **Step 4: Implement the scenarios.** Create `scenarios/volatile-default.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toObserveCommand,
    toResultAssertion,
    toSendCommand,
    toStorageCountersCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * D2 and D55: a send with no options is receipted and leaves nothing in IndexedDB on either page. The
 * window opens with a reset; the durable owners' idle probes (`work-page`) are reported beside the
 * zero, never inside it (I2 owns a literal zero).
 */
export const volatileDefault: AlmConformanceScenarioDefinition = {
    scenarioId: 'volatile-default',
    scenarioKey: 'volatile-default',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toVolatileDefaultSenderCommands,
    toRecipientCommands: toVolatileDefaultReceiverCommands
};

function toVolatileDefaultSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(sender, 'storage-window-open', true),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: {}
        }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        toResultAssertion({
            step: sender,
            name: 'assert-acknowledged-1',
            resultName: 'observe-acknowledged-1',
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        }),
        toStorageCountersCommand(sender, 'storage-window', false),
        ...toVolatileStorageWindowAssertions(sender)
    ];
}

/** A reset after the arrival could only under-count; the sender's own window is the one that cannot. */
function toVolatileDefaultReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toStorageCountersCommand(receiver, 'storage-window-open', true),
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toStorageCountersCommand(receiver, 'storage-window', false),
        ...toVolatileStorageWindowAssertions(receiver)
    ];
}

function toVolatileStorageWindowAssertions(
    step: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toResultAssertion({
            step,
            name: 'assert-storage-window-admission',
            resultName: 'storage-window',
            field: 'byOwner.al-admission',
            operator: 'equals',
            expected: 0
        }),
        toResultAssertion({
            step,
            name: 'assert-storage-window-non-probe-work',
            resultName: 'storage-window',
            field: 'workNonProbeCount',
            operator: 'equals',
            expected: 0
        })
    ];
}
```

    Create `scenarios/durable-opt-in.ts` the same way (same imports plus `toAdmissionCommands`,
    `toReceiptsCommand`), `scenarioId`/`scenarioKey` `'durable-opt-in'`, `tags: SMOKE_TAGS`, sender:
    `[storage-window-open (reset), toSendCommand({ …, index: 1, payload: { marker }, delivery: { durability: 'local-inbox' } }), …toAdmissionCommands({ …sender, index: 1 }), toReceiptsCommand({ …sender, index: 1 }), storage-window (no reset), assert byOwner.al-admission gt 0]`;
    receiver: `[storage-window-open (reset), toReceivedCommand({ …, index: 1, count: 1, absent: false }), storage-window, assert byOwner.al-admission gt 0]`.
    Doc on the scenario: "The channel that opts in pays for storage on both pages; its reload survival
    is `delivery-reload`'s, which opts into `local-outbox`." Add both ids to `AlmConformanceScenarioId`,
    register them in `ALM_CONFORMANCE_SCENARIOS` in the Interfaces order, and in
    `scenarios/delivery-baseline.ts` delete `toStorageCountersAssertCommand` and its call (keep the
    `storage-counters` read as evidence). `hetzner-alm-manifest-entries.ts:52-54` description: "ALM
    conformance family (the volatile default, bounded rejection, deadline expiry, delivery baseline,
    lifecycle, the durable opt-in, durable reload, ordering resync, the cross-carrier duplicate, and
    not-yet-in-sync) across ws, rtc, and rtc-with-ws-fallback carriers."

- [ ] **Step 5: The storage snapshot's volatile leg.** In `al-storage-snapshot.test.ts` add, after the
      durable workload, the same workload through a runtime that holds the same IndexedDB pair and a
      `createVolatileALOutboundRuntimeStores` pair with `persist: false` plans (msgIds suffixed
      `-volatile`), and the inbound leg through a runtime with a `createVolatileALInboundRuntimeStores`
      pair and messages that request no durability; read the IndexedDB snapshot again and assert it is
      unchanged from the durable reading (`toEqual` on `rowsByStatus` and on the byte totals within the
      band). Record the snapshot's new key: `volatile: { outboundRowsAdded: 0, inboundRowsAdded: 0 }`
      (the written-keys list gains `'volatile'`). The durable figures (`EXPECTED_BYTES_BY_TOPIC`,
      `EXPECTED_INBOUND_BYTES_BY_TOPIC`, 216/72 rows) do not move; their comment gains "S3a: these are the
      durable opt-in's figures; the volatile default adds 0 rows."

- [ ] **Step 6: GREEN.** Run the Step 2 command and `npx vitest run packages/tests/shared/alm/al-storage-snapshot.test.ts packages/tests/shared-test packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
      after `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`. Then the
      per-task validation list; the smoke lane
      `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` must show
      `volatile-default` and `durable-opt-in` green on all three carriers — read each cell's observation
      artifact and note the sender's and receiver's `workProbeCount` for `volatile-default` in the
      commit body (the probes the zero is reported beside); then the full scope once,
      `RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm`, and the three-agent
      family unchanged and green.

- [ ] **Step 7: Commit.**

```bash
git add packages/shared-test apps/rallar-black-box packages/tests
git commit -m "test(alm): the volatile-default and durable-opt-in lane family, a reset storage window and the volatile storage snapshot (D55)"
```

---

### Task 7 (droppable): Carrier capabilities installed in the composition

Droppable: it moves ownership only. If the slice runs long, record "Task 7 dropped, carried to S3b"
under "Rulings during execution" and go to Task 8.

**Files:**

- Create: `packages/shared/al-contracts/al-carrier-capabilities.ts`
- Modify: `packages/shared/al-contracts/validate-al-ack-support.ts:26,42-56` (the two wrappers and
  `AL_RECEIVER_DECLARING_ACK_ALGOS` deleted), `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:16,158`,
  `packages/shared/services/ws-queue-box-client-service.ts:19,255,636-663`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts:18,202-212`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts` (planning construction),
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts:48-73`,
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts:241-256,312-321`, and every
  direct `new WebRtcOverlayMulticastManager(` in `packages/tests` (14 files: `rg -l "new (shared\.)?WebRtcOverlayMulticastManager\(" packages`).
- Test: create `packages/tests/shared/al-contracts/al-carrier-capabilities.test.ts`;
  `packages/tests/shared/al-contracts/validate-al-ack-support.test.ts`.

**Interfaces:**

- Produces `export interface ALCarrierCapabilities { readonly name: 'ws-client' | 'rtc-overlay' | 'ws-server'; readonly qos: ALQosCapabilities; }`,
  `AL_WS_CLIENT_CAPABILITIES`, `AL_RTC_OVERLAY_CAPABILITIES`, `AL_WS_SERVER_CAPABILITIES` (each the full
  `DEFAULT_AL_QOS_CAPABILITIES` with `supportedAck: ['none', 'hop', 'subtree', 'receiver']`), and
  `toALCarrierQosInputProvider(capabilities: ALCarrierCapabilities, provider: ALQosInputProvider | undefined): ALQosInputProvider`
  — the application provider with the carrier's capabilities installed under its own.
- The carriers' `qosProvider` dependency becomes required `ALQosInputProvider` and is used as given;
  the composition roots install it: `createDefaultWsQueueBoxClientService` (`AL_WS_CLIENT_CAPABILITIES`),
  `initialiseRtcOverlayMulticastManager` (`AL_RTC_OVERLAY_CAPABILITIES`), the WS server service's
  planning construction (`AL_WS_SERVER_CAPABILITIES`). `DEFAULT_AL_QOS_CAPABILITIES` stays the base of
  carrier-less normalization (`resolveALDeliveryReceiptAlgo`, `resolveALInboundStoreDurability`).
  `computeALOutboundAckRefusal` reads `policy.capabilities`, now the carrier's own.

- [ ] **Step 1: RED.** Create `al-carrier-capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    AL_RTC_OVERLAY_CAPABILITIES,
    AL_WS_CLIENT_CAPABILITIES,
    AL_WS_SERVER_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { DEFAULT_AL_QOS_CAPABILITIES } from '@shared/al-contracts/al-policy.ts';

describe('carrier capabilities', () => {
    it.each([AL_WS_CLIENT_CAPABILITIES, AL_RTC_OVERLAY_CAPABILITIES, AL_WS_SERVER_CAPABILITIES])(
        'declares receiver on $name beside the default algorithms',
        (capabilities) => {
            expect(capabilities.qos).toEqual({
                ...DEFAULT_AL_QOS_CAPABILITIES,
                supportedAck: ['none', 'hop', 'subtree', 'receiver']
            });
        }
    );

    it('installs the carrier capabilities under the application provider', () => {
        const provider = toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, {
            capabilitiesForMessage: () => ({ maxFanout: 4 })
        });

        expect(provider.capabilitiesForMessage?.({} as never, { direction: 'outbound' })).toEqual({
            ...AL_RTC_OVERLAY_CAPABILITIES.qos,
            maxFanout: 4
        });
    });
});
```

    Move the receiver-support cases of `validate-al-ack-support.test.ts` that call the deleted
    wrappers onto `toALCarrierQosInputProvider` with the matching constant.

- [ ] **Step 2: Run.** `npx vitest run packages/tests/shared/al-contracts`
      Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement** the module; delete the two wrappers; make each carrier read its injected
      provider; install the providers at the three composition roots; add
      `qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined)` to each direct
      test construction of the RTC manager.

- [ ] **Step 4: GREEN.** `npx vitest run packages/tests/shared packages/tests/shared-web packages/tests/shared-server packages/tests/shared-test`;
      the refusal pins (`receiver` on a WS unicast and on world/all refused `unsupported`; accepted on
      rooms and on RTC) are unchanged. Then the per-task validation list and the smoke lane.

- [ ] **Step 5: Commit.**

```bash
git add packages/shared packages/shared-web/browser packages/tests
git commit -m "refactor(alm): each carrier owns its capability declaration, installed by its composition root"
```

---

### Task 8: Docs, the reads, the PR

**Files:** `packages/shared/alm/outbound/README.md` (the store section around :82-99 and :459-472, the
routing rules, the volatile eviction, the S3a figures), `packages/shared/alm/inbound/README.md:33-54`
(the memory and IndexedDB lanes of the one session store, D20 kept; the carried-durability rule; the
origin ACK short-circuit), `playground/alm/alm-complete-product-description.md` (:287-304 "QoS
negotiation" PLANNED → the purpose table delivered, capabilities per Task 7 or carried; :314-337 the D2
default now receipted and volatile; :454-500 "Durability" PLANNED S3 → delivered, with the memory pair,
the eviction on the owner's round, the probes reported beside the zero), `playground/alm/alm-improvement-plan.md`
(the S3 bullet: "S3a delivered by #<PR>"; revision history entry), `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md:388-392`
(`storage.counters` `reset`, `workProbeCount`, `workNonProbeCount`, the window pattern),
`packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md` (the reset-aware work-page rate).

- [ ] **Step 1: Write the docs** as listed; every figure quoted is the one the tests pin (10 + 15 and 8
      durable; 0 + 0 and 0 volatile; the storage snapshot's durable figures unchanged and 0 volatile
      rows).
- [ ] **Step 2: The local reads.** `npm run test:unit`, `npm run test:deno`, the three `deno task check`,
      `npm run typecheck`, `npm run build`, `npm run check:repo-style:changed -- origin/main HEAD`,
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`,
      `npm run test:repo-governance`, the bundle and public API tests, the full local lane on every carrier
      (two- and three-agent) on normal pages. Record passed / failed / skipped for each.
- [ ] **Step 3: Push, the PR, the hosted reads.** Push the branch; open the PR in the S2c-ii shape: the
      decisions applied (D52, D54, D55; D53/D59 constraints), the S3a behaviour for `command` over a WS
      unicast, the durability-routing rule, the storage figures (durable unchanged, volatile 0), the
      bundle figures, the moved pins by kind, the rulings, the carried lists, and what pending ALM work a
      deploy discards (none: no schema bump, the old durable rows keep draining in the durable lane).
      Hosted smoke on both-normal runners; the hosted full read with `RALLAR_BLACK_BOX_ALM_SCOPE=full`
      at most twice (D51), reported under the two-regime rule, never a blocker. The Branch Release Gate
      green on the final commit.

```bash
git add packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md playground/alm packages/shared-test/rallar-bb-test/docs
git commit -m "docs(alm): S3a -- purpose, the receipted volatile default, store lanes and the volatile proof"
```

## Rulings to take before execution

The controller settles these before Task 1 (record each as R-S3a-0):

1. **`alignRequestedDurability` does not raise.** The proposal says it "stops raising". In the code it
   picks the strongest supported durability _not above the request_ and replaces the effective only
   when that is stronger than the normalized one (`normalize-al-qos-policy.ts:693-715`); a requested
   `volatile` already normalizes to `volatile` today. The durable default came from
   `toALQosPolicyRequest`/`toDefaultEffectivePolicy` deriving `local-outbox` from `at-least-once`
   (:179-181, :273-276), which Task 3 removes. Recommended: leave `alignRequestedDurability` as it is.
2. **The server's `persist` keeps its meaning under `shouldAwaitALRoute`.** The WS server planner uses
   `persist` to resolve recipients at dequeue and fan out through the cluster
   (`ws-queue-box-server-outbound-planning.ts:95-133`); reading durability alone there would resolve a
   volatile at-least-once room broadcast at enqueue and drop cluster fan-out. Task 3 swaps the predicate
   name; the value differs only for a best-effort `local-inbox` request no caller sends.
   Recommended: no medium-scale Postgres gate for S3a (no server behaviour change); run it if the
   controller reads the swap as a mutation-path change.
3. **The RTC missing-channel check keeps its meaning.** `readMissingImmediatePeer` refuses a dispatch
   whose next hop has no channel unless the message "persists" (`web-rtc-overlay-multicast-manager.ts:673-680`);
   with durability decoupled, every volatile default send would be refused `no-route` and fall back to
   WS whenever one channel is missing. Task 3 keys it on `shouldAwaitALRoute` (retries or persists), as
   today. Recommended: accept.
4. **Lane sends become volatile too.** Durability is decoupled in normalization, so a lane send
   (`messages.rtc.send`, `messages.ws.send`: CRDT sync, the black-box lane commands) that names no
   durability is volatile after Task 3; CRDT keeps its own HTTP/WS catch-up for durability. Recommended:
   accept (D2's "durability is an explicit opt-in" read for every send); the alternative keeps
   at-least-once lane sends durable by leaving the normalization default and only stamping
   `qos.durability` on typed sends — smaller, but it keeps the reliability→durability coupling the
   proposal (§1.1) names as the defect.
5. **"Cleanup learns the memory pair" read as ownership.** `browser-al-runtime-cleanup.ts` stays
   IndexedDB-only; the memory pair dies with its runtime (session end) and a storage reset never touches
   it; expired memory rows are evicted on the owning lane's round (no timer). Without that eviction the
   memory pair would grow for the whole tab lifetime — nothing evicts `InMemoryQueueBox` rows in ALM use
   today (`cleanupAsync` is called only from `isAnyEntryToLock`, which ALM never calls). Recommended:
   accept; the alternative (the 60 s IndexedDB eviction loop also sweeping the session's memory pairs)
   needs the loop to hold the session's pairs, a registry the constraints forbid.
6. **The product description's `:337` rule** ("an explicit at-least-once request with `ack: none` is
   invalid"). S3a removes the default of that shape but still admits an explicit request of it (the
   director relay's WS unicast fallback and the receipt-less RTC carry rely on best-effort/explicit
   shapes). Recommended: S3a rewrites the sentence to "the default is receipted; an explicit
   at-least-once request with `ack: 'none'` retries without a receipt" and adds no validation.
7. **Ordering and supersedence tracks do not span stores.** A track (the RTC room `orderingKey`, a
   supersedence key) whose messages declare different durabilities lives half in each lane, so a
   per-send durability override on an ordered or superseding channel splits that track. No caller does
   this; the READMEs state it as an invariant. Recommended: accept for S3a; R1 (arbitration) or I2 owns
   a cross-store track if one is ever needed.
8. **`ALDeliveryLifecycle.ackMode` is kept and `receiptAlgo` added** (the "extends additively" rule).
   The alternative — retyping `ackMode` to the effective `ALAckAlgo` — is simpler to read but changes
   three in-repo reads (`to-arena-labels.ts:108`, two test pins) and the public type. Recommended: keep
   the additive field.

## Rulings during execution

- **R-S3a-0 (controller, 2026-09-26, before Task 1).** The eight pre-execution rulings above are taken as
  recommended, with two amendments: (2) the medium-scale Postgres gate runs once on the final S3a tree
  in Task 8 (the predicate rename touches the WS server planner even though its value is unchanged for
  every caller; three minutes buys the proof); (4) lane sends becoming volatile is accepted and is named
  in the PR body as a behaviour change for CRDT sync and the black-box lane commands (CRDT keeps its own
  catch-up; crash survival of a queued lane send now needs `qos.durability: 'local-outbox'`). The
  plan's S3a shape for `command` over a WS unicast (the case never occurs on a typed channel; both
  purposes default to `receiver` on room targets on every carrier, `command` as wire `'receiver'` and
  `notification` as `'all-logical-recipients'`; typed `world`/`all` broadcasts keep `ack: 'none'` until
  A1) is accepted over the proposal's "WS unicast keeps `hop`" sketch. Task 7 stays droppable and runs
  last. Cost if wrong: one extra gate run; one documented behaviour change the maintainer can revert
  by pinning `local-outbox` on the lane sends.

## Self-review

- **Spec coverage.** Purpose on the channel, `realtime` refused, the strategy retired, the table in
  `al-contracts`, per-send override → Task 1. The receipted default and the handle's receipt from the
  effective policy → Tasks 1–2; the carried R-S2c-ii-5a verification → Task 2 Step 5. Durability
  decoupled, `volatile` honoured, the opt-in per channel and per send → Tasks 1 and 3. Two stores per
  runtime chosen per message, handlers per pair on the shared engine, cleanup/reset → Tasks 4–5 (and
  ruling 5). The receiving side's durability → Task 5 (and the section above). The server's one backend
  → Global Constraints, Task 3 ruling 2. The volatile proof (reset window, by-kind read, zero pins,
  probes beside, `delivery-baseline` → `durable-opt-in`, the unit pins, the storage snapshot) → Tasks 4,
  5, 6. Capabilities in the composition → Task 7 (droppable). Docs → Task 8. D53 and D59 are respected
  as constraints.
- **Placeholder scan.** Mechanical call-site edits name their files and lines; the one open-ended step
  (Task 3 Step 8) is bounded to two named edit kinds with an explicit stop rule.
- **Type consistency.** `resolveALChannelSendDefaults` (Task 1) is what Task 2's RTC test builds its
  envelope with; `shouldPersistOutbox`/`shouldAwaitALRoute` (Task 3) feed `plan.persist`, which Task 4's
  `selectLaneForPlan` reads; `shouldPersistInbox` (Task 3) is what Task 5's
  `resolveALInboundStoreDurability` reads; `ALVolatileOutboundRuntimeStores.evictExpired` and
  `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` (Task 4) are reused by Task 5; the harness `durability`
  (Task 3) is what Task 6's `durable-opt-in` sends; `workNonProbeCount` (Task 6 Step 3) is what its
  scenarios assert.
