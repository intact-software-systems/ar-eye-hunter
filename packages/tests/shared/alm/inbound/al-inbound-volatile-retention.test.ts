import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS, newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import {
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import { evictTerminalVolatileInboundMessages } from '@shared/alm/inbound/admission/evict-terminal-volatile-inbound-messages.ts';
import {
    createALInboundAdmissionStore,
    createVolatileALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type CreateALInboundAdmissionStoreInput
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundMessageKey } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { toALInboundMessageOwnerKey } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import { toALInboundControlAcksKey } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    readInboundTestDecisionSurface,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

const NAMESPACE = 'inbound-retention';

interface ObservedBackend {
    readonly state: ALAdmissionMemoryState;
    readonly backend: InMemoryAdmissionBackend;
}

interface ObservedInboundPairs {
    readonly fixture: InboundTestRuntime;
    readonly durable: ALAdmissionMemoryState;
    readonly volatile: ALAdmissionMemoryState;
    readonly durableStore: ALInboundAdmissionStore;
    readonly volatileStore: ALInboundAdmissionStore;
}

interface RowExpiries {
    readonly owner: number | undefined;
    readonly canonicalMessage: number | undefined;
}

describe('the owner row a volatile inbound message keeps (D74)', () => {
    it('keeps provenance when the receiver normalizes an explicit no-ACK envelope to hop ACK', async () => {
        useFakeDate();
        const message = createPermanentMessage('receiver-normalized-ack');
        const normalized = planALMessageHandling(message, {
            selfPeerId: INBOUND_TEST_SELF_PEER_ID,
            fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
            nowMs: Date.now()
        }, {
            defaults: { ack: { algo: 'hop', opts: { timeoutMs: 1000 } } },
            capabilities: { supportedAck: ['hop'] }
        });
        expect(normalized.ack).toMatchObject({ enabled: true, algo: 'hop' });
        const normalizedPlan = (plan: ALMessageHandlingPlan): ALMessageHandlingPlan => ({
            ...plan,
            effective: normalized.effective,
            ack: normalized.ack
        });
        const pairs = await createReadyObservedPairs(normalizedPlan);

        expect((await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        await expect.poll(() => pairs.fixture.controlSends.flat().length).toBe(1);
        await expect.poll(() => pairs.fixture.delivered.length).toBe(1);
        evictTerminalVolatileInboundMessages(new InMemoryAdmissionBackend(pairs.volatile, Date.now), NAMESPACE);

        expect(readRowExpiries(pairs.volatile, message).owner)
            .toBe(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);
        const rtc = createInboundTestRuntime({
            stores: pairs.fixture.stores,
            volatileStores: {
                admissionStore: pairs.volatileStore,
                workQueue: pairs.volatile.workQueue,
                evictExpired: () => {},
                budget: undefined
            },
            carrier: 'rtc',
            effectWorkerId: 'al-inbound:retention-rtc',
            plan: normalizedPlan
        });
        await rtc.runtime.ready();
        expect(
            (await rtc.runtime.admitIncomingMessage(message, {
                kind: 'rtc-peer',
                peerId: INBOUND_TEST_SENDER_PEER_ID
            })).right
        ).toEqual({ kind: 'duplicate' });
        await expect.poll(() => rtc.controlSends.flat().length).toBe(1);
    });

    it('reclaims a no-ACK owner-only admission while preserving its dedup horizon', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message: ALMessage = {
            ...createPermanentMessage('owner-only'),
            targets: { mode: 'unicast', toPeerId: 'another-peer' }
        };
        const admittedAtMs = Date.now();
        expect((await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        expect(readRowExpiries(pairs.volatile, message))
            .toEqual({
                owner: readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS,
                canonicalMessage: undefined
            });

        evictTerminalVolatileInboundMessages(new InMemoryAdmissionBackend(pairs.volatile, Date.now), NAMESPACE);

        expect(readRowExpiries(pairs.volatile, message).owner).toBeUndefined();
        expect(pairs.fixture.delivered).toEqual([]);
        vi.setSystemTime(admittedAtMs + 60 * 60_000 - 1);
        expect((await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'duplicate' });
    });

    it.each(['replacement', 'checkpoint reload', 'terminal reload', 'replacement reload'] as const)(
        'preserves provenance without admission-time proof after %s',
        async (change) => {
            useFakeDate();
            const pairs = await createReadyObservedPairs();
            const message = createPermanentMessage(`unproven-${change}`);
            expect((await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
                .toEqual({ kind: 'admitted' });
            await expect.poll(() => pairs.fixture.delivered.length).toBe(1);
            const key = toALInboundMessageOwnerKey(NAMESPACE, message.id.msgId, message.id.senderId);
            const original = pairs.volatile.data.get(key)!;
            const state = change === 'checkpoint reload' ? createInMemoryALAdmissionState() : pairs.volatile;
            const backend = new InMemoryAdmissionBackend(state, Date.now);
            if (change === 'replacement' || change === 'replacement reload') {
                await backend.write((transaction) => transaction.set(key, original.value, original.expireAtTimestamp));
                if (change === 'replacement reload') {
                    await backend.write((transaction) => transaction.remove(key));
                    backend.loadIfAbsent([original], []);
                }
            }
            else {
                if (change === 'terminal reload') {
                    evictTerminalVolatileInboundMessages(backend, NAMESPACE);
                    expect(readRowExpiries(state, message).owner).toBeUndefined();
                }
                backend.loadIfAbsent([original], []);
            }

            evictTerminalVolatileInboundMessages(backend, NAMESPACE);

            expect(readRowExpiries(state, message).owner).toBe(original.expireAtTimestamp);
        }
    );

    it('reclaims permanent non-receipted provenance after delivery without shortening dedup', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const admittedAtMs = Date.now();
        const message = createPermanentMessage('permanent-state');
        const admit = () => pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);

        expect((await admit()).right).toEqual({ kind: 'admitted' });
        await expect.poll(() => pairs.fixture.delivered.length).toBe(1);
        const backend = new InMemoryAdmissionBackend(pairs.volatile, Date.now);
        const observed: RowExpiries[] = [];
        backend.onChangeDo(() => observed.push(readRowExpiries(pairs.volatile, message)));
        evictTerminalVolatileInboundMessages(backend, NAMESPACE);
        expect(readRowExpiries(pairs.volatile, message).owner).toBeUndefined();
        expect(observed).toEqual([
            { owner: undefined, canonicalMessage: undefined },
            { owner: undefined, canonicalMessage: undefined }
        ]);
        vi.setSystemTime(admittedAtMs + 60 * 60_000 - 1);
        expect((await admit()).right).toMatchObject({ kind: 'duplicate' });

        vi.setSystemTime(admittedAtMs + 60 * 60_000);
        backend.evictExpired();
        expect(readRowExpiries(pairs.volatile, message).owner).toBeUndefined();
        expect([...pairs.volatile.data.keys()].filter((key) => key.includes(':dedup:'))).toEqual([]);
    });

    it('keeps a receipted message owner through a deadline beyond the repository horizon', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message: ALMessage = {
            ...createInboundTestMessage({ msgId: 'long-receipt', acknowledged: true }),
            constraints: { expiresAtMs: Date.now() + 2 * 60 * 60_000 }
        };

        expect((await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        await expect.poll(() => pairs.fixture.delivered.length).toBe(1);
        evictTerminalVolatileInboundMessages(new InMemoryAdmissionBackend(pairs.volatile, Date.now), NAMESPACE);
        expect(readRowExpiries(pairs.volatile, message).owner)
            .toBe(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);
    });

    it('plateaus across three retention horizons while fresh dedup identities remain protected', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const backend = new InMemoryAdmissionBackend(pairs.volatile, Date.now);
        const startedAtMs = Date.now();
        const counts: number[] = [];
        for (let minute = 0; minute < 180; minute += 1) {
            vi.setSystemTime(startedAtMs + minute * 60_000);
            const message = createPermanentMessage(`state-${minute}`);
            expect((await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
                .toEqual({ kind: 'admitted' });
            await expect.poll(() => pairs.fixture.delivered.length, { interval: 1 }).toBe(minute + 1);
            backend.evictExpired();
            evictTerminalVolatileInboundMessages(backend, NAMESPACE);
            expect([...pairs.volatile.data.keys()].filter((key) => key.includes(':msg-owner:'))).toEqual([]);
            if ((minute + 1) % 60 === 0) {
                counts.push([...pairs.volatile.data.keys()].filter((key) => key.includes(':dedup:')).length);
            }
        }
        expect(counts).toEqual([60, 60, 60]);
    });

    it('keeps it for the message deadline plus the receipt grace, past the work the message owns', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message = createInboundTestMessage({ msgId: 'volatile-owner' });

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right
        )
            .toEqual({ kind: 'admitted' });

        const rows = readRowExpiries(pairs.volatile, message);
        expect(rows.owner).toBe(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);
        // The canonical envelope lives exactly as long as the work that names it: the dispatch, at the deadline.
        expect(rows.canonicalMessage).toBe(readDeadlineMs(message));
    });

    it('keeps a durable message owner row for the repository retention, as before', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message = createInboundTestMessage({
            msgId: 'durable-owner',
            durability: 'local-inbox'
        });
        const admittedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right
        )
            .toEqual({ kind: 'admitted' });

        expect(readRowExpiries(pairs.durable, message).owner).toBe(
            admittedAtMs + 60 * 60_000
        );
    });

    it('gives a volatile message that names no deadline the one its admission implies, plus the grace', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message = newALUnicastMessage(
            INBOUND_TEST_SENDER_PEER_ID,
            { topicId: 'chat', resourceId: 'no-deadline', contextId: 'room' },
            INBOUND_TEST_SELF_PEER_ID,
            'chat.private-text.v1',
            { text: 'no-deadline' }
        );
        const admittedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right
        )
            .toEqual({ kind: 'admitted' });

        // The admission implies `nowMs + durableEffectTtlMs` (30 min) for a message with no expiry of its own.
        expect(readRowExpiries(pairs.volatile, message).owner)
            .toBe(admittedAtMs + 30 * 60_000 + AL_RECEIPT_DEADLINE_GRACE_MS);
    });
});

function createPermanentMessage(resourceId: string): ALMessage {
    return {
        ...newALUnicastMessage(
            INBOUND_TEST_SENDER_PEER_ID,
            { topicId: 'state', resourceId, contextId: 'room' },
            INBOUND_TEST_SELF_PEER_ID,
            'state.snapshot',
            { revision: 1 }
        ),
        constraints: { expiresAtMs: NEVER_EXPIRE_AT_TIMESTAMP },
        delivery: { ownership: 'shared', reliability: 'at-least-once', ack: 'none' }
    };
}

/** Fakes only the clock the rows are stamped with; the rotation keeps its real timers. */
function useFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
}

/** A durable and a volatile memory pair whose admission maps the test reads back, behind one ready runtime. */
async function createReadyObservedPairs(
    plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan
): Promise<ObservedInboundPairs> {
    const durable = createObservedBackend();
    const volatile = createObservedBackend();
    const durableStore = createALInboundAdmissionStore(toStoreInput(durable.backend));
    const volatileStore = createVolatileALInboundAdmissionStore(toStoreInput(volatile.backend));
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        plan,
        stores: { admissionStore: durableStore, workQueue: durable.backend.workQueue },
        volatileStores: {
            admissionStore: volatileStore,
            workQueue: volatile.backend.workQueue,
            evictExpired: () => volatile.backend.evictExpired(),
            budget: undefined
        },
        effectWorkerId: 'al-inbound:retention'
    });
    await fixture.runtime.ready();
    return {
        fixture,
        durable: durable.state,
        volatile: volatile.state,
        durableStore,
        volatileStore
    };
}

function createObservedBackend(): ObservedBackend {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    return { state, backend: new InMemoryAdmissionBackend(state, Date.now) };
}

function toStoreInput(backend: InMemoryAdmissionBackend): CreateALInboundAdmissionStoreInput {
    return {
        nowMs: Date.now,
        namespace: NAMESPACE,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        maxOrderingTracks: undefined,
        maxDeliveredMarkers: undefined
    };
}

function readDeadlineMs(message: ALMessage): number {
    const deadlineAtMs = message.constraints?.expiresAtMs;
    if (deadlineAtMs === undefined) {
        throw new Error('The fixture message names its deadline');
    }
    return deadlineAtMs;
}

function readRowExpiries(
    state: ALAdmissionMemoryState,
    message: ALMessage
): RowExpiries {
    const { msgId, senderId } = message.id;
    return {
        owner: state.data.get(toALInboundMessageOwnerKey(NAMESPACE, msgId, senderId))
            ?.expireAtTimestamp,
        canonicalMessage: state.data.get(toALInboundMessageKey(NAMESPACE, { msgId, senderId }))
            ?.expireAtTimestamp
    };
}

describe('the acknowledgement history a volatile relay row keeps (D74)', () => {
    it('keeps it for the relayed message deadline plus the receipt grace', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const tracked = createInboundTestMessage({ msgId: 'relayed-volatile' });
        await seedRelayRow(pairs.volatileStore, tracked, readDeadlineMs(tracked));

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(
                toSenderAck(tracked),
                INBOUND_TEST_SOURCE
            )).right
        )
            .toEqual({ kind: 'control', handled: true });

        expect(readAcksExpiry(pairs.volatile, tracked)).toBe(
            readDeadlineMs(tracked) + AL_RECEIPT_DEADLINE_GRACE_MS
        );
    });

    it('keeps it for the 30 minute control-history TTL when the relayed message named no deadline', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const tracked = newALUnicastMessage(
            INBOUND_TEST_SENDER_PEER_ID,
            { topicId: 'chat', resourceId: 'relayed-no-deadline', contextId: 'room' },
            INBOUND_TEST_SELF_PEER_ID,
            'chat.private-text.v1',
            { text: 'relayed-no-deadline' }
        );
        await seedRelayRow(pairs.volatileStore, tracked, undefined);
        const acknowledgedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(
                toSenderAck(tracked),
                INBOUND_TEST_SOURCE
            )).right
        )
            .toEqual({ kind: 'control', handled: true });

        expect(readAcksExpiry(pairs.volatile, tracked)).toBe(acknowledgedAtMs + 30 * 60_000);
    });

    it('keeps it for the control-history TTL on the durable pair, as before', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const tracked = createInboundTestMessage({
            msgId: 'relayed-durable',
            durability: 'local-inbox'
        });
        await seedRelayRow(pairs.durableStore, tracked, readDeadlineMs(tracked));
        const acknowledgedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(
                toSenderAck(tracked),
                INBOUND_TEST_SOURCE
            )).right
        )
            .toEqual({ kind: 'control', handled: true });

        expect(readAcksExpiry(pairs.durable, tracked)).toBe(
            acknowledgedAtMs + 30 * 60_000
        );
    });
});

/** The relay row this peer keeps for the tracked message: the fixture sender owes one ACK, before any deadline. */
async function seedRelayRow(
    store: ALInboundAdmissionStore,
    message: ALMessage,
    deadlineAtMs: number | undefined
): Promise<void> {
    const rowExpiresAtMs = deadlineAtMs ?? Date.now() + 60_000;
    const { msgId, senderId } = message.id;
    const committed = await store.commitBundle({
        admissionExpiresAtMs: null,
        senderId,
        observations: (await readInboundTestDecisionSurface(store, message)).observations,
        mutations: [{
            kind: 'set-msg-owner',
            value: { msgId, senderId, source: INBOUND_TEST_SOURCE, supersedenceKey: null },
            expireAtTimestamp: rowExpiresAtMs + AL_RECEIPT_DEADLINE_GRACE_MS
        }, {
            kind: 'set-control-pending',
            msgId,
            senderId,
            value: {
                kind: 'pending',
                value: {
                    toPeerId: 'upstream',
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: [INBOUND_TEST_SENDER_PEER_ID],
                    ackedFromPeerIds: [],
                    ...(deadlineAtMs === undefined ? {} : { expireAtTimestamp: deadlineAtMs }),
                    carrier: 'ws'
                }
            },
            expireAtTimestamp: rowExpiresAtMs
        }, {
            kind: 'set-control-owners',
            msgId,
            value: {
                ambiguous: false,
                values: [{ peerId: INBOUND_TEST_SENDER_PEER_ID, senderId }]
            },
            expireAtTimestamp: rowExpiresAtMs
        }],
        durableEffects: []
    });
    expect(committed).toBe('committed');
}

function toSenderAck(tracked: ALMessage): ALMessage {
    return newALAckControlMessage(
        {
            v: 4,
            msgId: `ack-${tracked.id.msgId}`,
            senderId: INBOUND_TEST_SENDER_PEER_ID,
            ts: Date.now(),
            traceId: 'trace-al-inbound-volatile-retention'
        },
        {
            ackedMsgId: tracked.id.msgId,
            fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
            toPeerId: INBOUND_TEST_SELF_PEER_ID,
            originPeerId: tracked.id.senderId,
            logicalRecipientPeerId: INBOUND_TEST_SENDER_PEER_ID,
            carrier: 'ws',
            status: 'accepted',
            observedAtEpochMs: Date.now()
        }
    );
}

function readAcksExpiry(state: ALAdmissionMemoryState, message: ALMessage): number | undefined {
    const { msgId, senderId } = message.id;
    return state.data.get(toALInboundControlAcksKey(NAMESPACE, msgId, senderId))?.expireAtTimestamp;
}
