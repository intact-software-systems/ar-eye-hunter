import { afterEach, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import {
    AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS,
    type ALInboundMessageRuntime
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID,
    setNextInboundCommitConflicted,
    type InboundTestRuntime,
    type InboundTestStorage
} from './inbound-runtime-test-fixture.ts';

import '../../setup-browser-indexeddb.ts';

type AdmissionOutcomeEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'admission-outcome'; }>;
type EffectDrainEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;
type RotationAliveEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'rotation-alive'; }>;
type ClaimSettledEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'claim-settled'; }>;
type ReadInboundPendingAuthority = NonNullable<ALInboundMessageRuntime.Dependencies['readPendingAdmissionAuthority']>;

/** Engine rounds one poll attempt drives, so the rotation reaches its liveness cadence in a few. */
const ROTATION_ROUNDS_PER_ATTEMPT = 16;
const DIAGNOSTICS_NAMESPACE = 'inbound-admission-diagnostics';
const DIAGNOSTICS_WORKER_ID = 'inbound-diagnostics-worker';

interface InboundDiagnosticsFixtureInput {
    readonly kind: InboundTestStorage;
    readonly plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan;
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
    readonly dispatchOutcome?: 'completed' | 'retry';
    readonly readPendingAdmissionAuthority?: ReadInboundPendingAuthority;
}

afterEach(() => {
    vi.restoreAllMocks();
});

function createRuntime(input: InboundDiagnosticsFixtureInput): InboundTestRuntime {
    return createInboundTestRuntime({
        stores: createInboundTestStores({
            namespace: DIAGNOSTICS_NAMESPACE,
            storage: input.kind,
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: DIAGNOSTICS_WORKER_ID,
        canDispatchMessage: input.canDispatchMessage,
        plan: input.plan,
        dispatchOutcome: input.dispatchOutcome,
        readPendingAdmissionAuthority: input.readPendingAdmissionAuthority
    });
}

function admissionOutcomesOf(
    diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]
): readonly AdmissionOutcomeEvent[] {
    return diagnostics.filter((event): event is AdmissionOutcomeEvent => event.kind === 'admission-outcome');
}

function drainsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly EffectDrainEvent[] {
    return diagnostics.filter((event): event is EffectDrainEvent => event.kind === 'effect-drain');
}

function rotationsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly RotationAliveEvent[] {
    return diagnostics.filter((event): event is RotationAliveEvent => event.kind === 'rotation-alive');
}

function claimsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly ClaimSettledEvent[] {
    return diagnostics.filter((event): event is ClaimSettledEvent => event.kind === 'claim-settled');
}

/** Runs bounded engine rounds until the rotation reports itself alive, so an absence can be read. */
async function runRotationUntilAlive(
    queueEngine: InboxOutboxEngine,
    diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]
): Promise<void> {
    const roundLimit = AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS * 8;
    for (let round = 0; round < roundLimit && rotationsOf(diagnostics).length === 0; round += 1) {
        await queueEngine.executeOnce();
        // A round the owner spends inside a batch it started itself reports no work: let it settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

it.each(['memory', 'indexeddb'] as const)(
    'names the message an ingress committed and the drain that delivered it over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind });
        const message = createInboundTestMessage({ msgId: 'committed-delivery' });

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(admissionOutcomesOf(diagnostics)).toEqual([{
            kind: 'admission-outcome',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            outcome: 'committed',
            reason: 'admitted'
        }]);

        await expect.poll(() => delivered).toEqual(['dispatched']);
        // Only batches that touched work report; the rotation's empty rounds stay silent.
        const claimed = drainsOf(diagnostics);
        expect(claimed.map((event) => ({
            workerId: event.workerId,
            claimedCount: event.claimedCount,
            completedCount: event.completedCount,
            rescheduledCount: event.rescheduledCount,
            rejectedCount: event.rejectedCount
        }))).toEqual([{
            workerId: DIAGNOSTICS_WORKER_ID,
            claimedCount: 1,
            completedCount: 1,
            rescheduledCount: 0,
            rejectedCount: 0
        }]);

        // The one claim that drain ran, named: the delivery effect holds a reference to the message,
        // which carries its id and not its type.
        const settled = claimsOf(diagnostics);
        expect(settled.map((event) => ({
            kind: event.kind,
            workerId: event.workerId,
            msgId: event.msgId,
            typeId: event.typeId,
            payloadKind: event.payloadKind,
            attempts: event.attempts,
            outcome: event.outcome
        }))).toEqual([{
            kind: 'claim-settled',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: null,
            payloadKind: 'dispatch-local',
            attempts: 1,
            outcome: 'completed'
        }]);

        // The batch's phases account for the claim it ran, and both read the same row's own wait.
        const drain = claimed[0]!;
        expect(settled[0]?.durationMs).toBeLessThanOrEqual(drain.runDurationMs);
        expect(settled[0]?.queueWaitMs).toBe(drain.queueWaitMs);
        expect(drain.selectionDurationMs + drain.claimDurationMs + drain.runDurationMs + drain.releaseDurationMs)
            .toBeLessThanOrEqual(drain.durationMs);
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'settles the claim as a retry when the dispatch it ran asked for one over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind, dispatchOutcome: 'retry' });

        await runtime.ready();
        await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'rescheduled-delivery' }),
            { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
        );
        await expect.poll(() => delivered).toEqual(['dispatched']);
        await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(1);

        // The row goes back to the queue, so the drain counts it rescheduled and the claim says why.
        expect(claimsOf(diagnostics)[0]?.outcome).toBe('retry');
        expect(drainsOf(diagnostics)[0]).toMatchObject({ claimedCount: 1, completedCount: 0, rescheduledCount: 1 });
    }
);

it.each(
    [
        ['not-ready', async () => ({ kind: 'retry', retryAfterMs: 60_000 })],
        ['non-retryable', async () => ({ kind: 'authorized', source: { kind: 'rtc-peer', peerId: 'impostor' } })]
    ] as const satisfies readonly (readonly [string, ReadInboundPendingAuthority])[]
)(
    'settles a retained admission as %s and names the message it replayed',
    async (outcome, readPendingAdmissionAuthority) => {
        const { runtime, stores, diagnostics } = createRuntime({
            kind: 'memory',
            readPendingAdmissionAuthority
        });
        const message = createInboundTestMessage({ msgId: `retained-${outcome}` });

        await runtime.ready();
        setNextInboundCommitConflicted(stores.admissionStore);
        const admitted = await runtime.admitIncomingMessage(
            message,
            { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
        );

        expect(admitted.right).toEqual({ kind: 'pending-admission' });
        await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(1);

        // A retained admission keeps the message itself, so this claim names both halves of its identity.
        expect(claimsOf(diagnostics)[0]).toMatchObject({
            kind: 'claim-settled',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            payloadKind: 'admit-message',
            attempts: 1,
            outcome
        });
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'names an unauthorized drop that writes nothing, sends no NACK and returns no error over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({
            kind,
            plan: (plan) => ({
                ...plan,
                dropReason: 'unauthorized',
                dropReasonCode: 'unauthorized',
                localDelivery: { enabled: false, persist: false, deferred: false },
                nack: { enabled: false, reason: 'unauthorized', missingSeqs: [] }
            })
        });
        const message = createInboundTestMessage({ msgId: 'unauthorized-drop' });

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });

        // Without this event the drop is indistinguishable from a delivery still on its way.
        expect(admitted.right).toEqual({ kind: 'not-admitted', reason: 'unauthorized' });
        expect(admissionOutcomesOf(diagnostics)).toEqual([{
            kind: 'admission-outcome',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            outcome: 'unauthorized',
            reason: 'unauthorized'
        }]);
        expect(delivered).toEqual([]);
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'separates a committed admission no consumer claims from one that was never admitted over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered, queueEngine } = createRuntime({
            kind,
            canDispatchMessage: () => false
        });
        const message = createInboundTestMessage({ msgId: 'no-inbox-consumer' });

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
        await runRotationUntilAlive(queueEngine, diagnostics);

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(admissionOutcomesOf(diagnostics).map((event) => event.outcome)).toEqual(['committed']);

        // The rotation ran over the committed row often enough to report itself alive, so this is the
        // absence of a claim rather than the absence of a rotation: no drain ever selects the row
        // while the consumer is missing, and a batch that touched nothing reports nothing.
        expect(rotationsOf(diagnostics).length).toBeGreaterThanOrEqual(1);
        expect(delivered).toEqual([]);
        expect(drainsOf(diagnostics)).toEqual([]);
    },
    30_000
);

it.each(['memory', 'indexeddb'] as const)(
    'reports the rotation still running while it claims nothing over %s',
    async (kind) => {
        const { runtime, diagnostics, queueEngine } = createRuntime({ kind, canDispatchMessage: () => false });

        await runtime.ready();
        await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'rotation-liveness' }),
            { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
        );
        await expect.poll(async () => {
            for (let round = 0; round < ROTATION_ROUNDS_PER_ATTEMPT; round += 1) {
                await queueEngine.executeOnce();
            }
            return rotationsOf(diagnostics).length;
        }, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

        // The witness that separates "no consumer is registered for this typeId" from "the rotation
        // stopped": the row is still there, still scanned, and still claimed by nobody.
        expect(rotationsOf(diagnostics)[0]).toMatchObject({
            kind: 'rotation-alive',
            workerId: DIAGNOSTICS_WORKER_ID,
            emptyRoundCount: AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS
        });
        // The slowest single round of them: a rotation that crawls says so without stopping.
        const rotation = rotationsOf(diagnostics)[0]!;
        expect(rotation.durationMs).toBeGreaterThanOrEqual(0);
        expect(rotation.longestRoundMs).toBeLessThanOrEqual(rotation.durationMs);
        expect(drainsOf(diagnostics)).toEqual([]);
    },
    30_000
);
