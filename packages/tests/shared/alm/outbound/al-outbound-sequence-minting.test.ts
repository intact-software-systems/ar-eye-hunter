import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS, normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { ALOutboundAdmissionMutations } from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { computeALOutboundSequenceMint } from '@shared/alm/outbound/admission/sequencing/compute-al-outbound-sequence-mint.ts';
import { toALOutboundMintingPlan } from '@shared/alm/outbound/admission/sequencing/to-al-outbound-minting-plan.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundDispatchPlan, ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createVolatileOutboundTestStores,
    OUTBOUND_TEST_SEND_PLANNER,
    readOutboundTestAdmission,
    runOutboundWorkTask,
    waitForOutboundWorkDrained,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUND_EVENT_TTL_MS = 60_000;

/** The WS server's own publication: one durable copy, and the track's next sequence for a key without one. */
const MINTING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
    mintsSequence: true
});

/** A browser session's own sends: one copy on the lane its durability names, a volatile one here. */
const BROWSER_SESSION_ID = 'session-a';
const BROWSER_VOLATILE_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'volatile',
    preparedMessages: [{ peer: 'receiver' }]
});

/** The browser carriers' composition: the minting plan at a first admission, the stored policy on every later plan. */
const BROWSER_MINTING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) =>
    toALOutboundMintingPlan(
        BROWSER_VOLATILE_PLANNER(msg, authority),
        authority === undefined ? 'admission' : 'replan',
        BROWSER_SESSION_ID
    );

interface MintingRuntime {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly sent: ALMessage[];
}

describe('outbound sequence minting', () => {
    it('mints 1, 2, 3 on one track and starts another key or another epoch at 1', async () => {
        const { runtime } = createMintingRuntime(createDefaultOutboundTestStores());

        expect(await enqueueMintedSeq(runtime, createRoundEvent('a-1', { orderingKey: 'game-1', epoch: 1 }))).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('a-2', { orderingKey: 'game-1', epoch: 1 }))).toBe(2);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('a-3', { orderingKey: 'game-1', epoch: 1 }))).toBe(3);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('b-1', { orderingKey: 'game-2', epoch: 1 }))).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('c-1', { orderingKey: 'game-1', epoch: 2 }))).toBe(1);
    });

    it('mints 1 again on a track whose head expired', async () => {
        const clock = mockClock();
        const { runtime } = createMintingRuntime(createDefaultOutboundTestStores());
        expect(await enqueueMintedSeq(runtime, createRoundEvent('first-1', { orderingKey: 'game-1', epoch: 1 }))).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('first-2', { orderingKey: 'game-1', epoch: 1 }))).toBe(2);

        clock.nowMs += DEFAULT_AL_REPOSITORY_TTL_MS + ROUND_EVENT_TTL_MS + 1;

        expect(await enqueueMintedSeq(runtime, createRoundEvent('after-expiry', { orderingKey: 'game-1', epoch: 1 }))).toBe(1);
    });

    it('keeps the sequence of an admitted message when the same message is admitted again', async () => {
        const { runtime } = createMintingRuntime(createDefaultOutboundTestStores());
        const message = createRoundEvent('again', { orderingKey: 'game-1', epoch: 1 });

        expect(await enqueueMintedSeq(runtime, message)).toBe(1);
        const repeated = await runtime.enqueueIfAbsent(message);

        expect(repeated.verdict.kind).toBe('duplicate');
        expect(repeated.message.ordering?.seq).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('next', { orderingKey: 'game-1', epoch: 1 }))).toBe(2);
    });

    it('stores, indexes and sends the minted message', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent } = createMintingRuntime(stores);
        const message = createRoundEvent('stored', { orderingKey: 'game-1', epoch: 3 });

        await runtime.enqueueIfAbsent(message);
        await runOutboundWorkTask(runtime);
        const stored = await stores.admissionStore.readSentMessage(message.id.msgId);

        expect(stored?.msg.ordering).toEqual({ orderingKey: 'game-1', epoch: 3, seq: 1 });
        expect((await stores.admissionStore.readSentMessageByOrdering(toALOrderingTrackKey(stored!.msg)!, 1))?.msgId)
            .toBe(message.id.msgId);
        expect(sent.map((frame) => frame.ordering)).toEqual([{ orderingKey: 'game-1', epoch: 3, seq: 1 }]);
    });

    it('continues the track where the store stands when a new runtime opens it', async () => {
        const stores = createDefaultOutboundTestStores();
        const first = createMintingRuntime(stores).runtime;
        for (const name of ['before-1', 'before-2', 'before-3']) {
            await enqueueMintedSeq(first, createRoundEvent(name, { orderingKey: 'game-1', epoch: 1 }));
        }
        await first.dispose();

        const restarted = createMintingRuntime(stores).runtime;

        expect(await enqueueMintedSeq(restarted, createRoundEvent('after', { orderingKey: 'game-1', epoch: 1 }))).toBe(4);
    });

    it('a conflicting mint never reuses a sequence: the replay of its pending admission mints the next one', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent } = createMintingRuntime(stores);
        const late = createRoundEvent('late', { orderingKey: 'game-1', epoch: 1 });
        const early = createRoundEvent('early', { orderingKey: 'game-1', epoch: 1 });
        interleaveAfterFirstDecisionRead(stores, async () => {
            const bundle = await readOutboundTestAdmission({
                store: stores.admissionStore,
                message: early,
                creationNow: () => Temporal.Now.instant(),
                clock: { nowMs: () => Date.now() },
                planner: MINTING_PLANNER
            });
            expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        });

        const result = await runtime.enqueueIfAbsent(late);

        expect(result.verdict.kind).toBe('pending');
        expect(result.message.ordering?.seq).toBeUndefined();
        expect(await stores.admissionStore.readSentMessage(late.id.msgId)).toBeUndefined();
        expect((await readCanonicalMessage(stores, late)).ordering).toEqual({ orderingKey: 'game-1', epoch: 1 });

        await runOutboundWorkTask(runtime);
        await waitForOutboundWorkDrained(stores);

        expect((await stores.admissionStore.readSentMessage(early.id.msgId))?.msg.ordering?.seq).toBe(1);
        expect((await stores.admissionStore.readSentMessage(late.id.msgId))?.msg.ordering?.seq).toBe(2);
        expect((await readCanonicalMessage(stores, late)).ordering?.seq).toBe(2);
        expect(sent.map((frame) => [frame.id.msgId, frame.ordering?.seq]))
            .toEqual(expect.arrayContaining([[early.id.msgId, 1], [late.id.msgId, 2]]));
        expect(sent).toHaveLength(2);
    });

    it('answers a second admission of a still-pending minting message with the request, not a sequence', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createMintingRuntime(stores);
        const late = createRoundEvent('late', { orderingKey: 'game-1', epoch: 1 });
        const early = createRoundEvent('early', { orderingKey: 'game-1', epoch: 1 });
        interleaveAfterFirstDecisionRead(stores, async () => {
            const bundle = await readOutboundTestAdmission({
                store: stores.admissionStore,
                message: early,
                creationNow: () => Temporal.Now.instant(),
                clock: { nowMs: () => Date.now() },
                planner: MINTING_PLANNER
            });
            expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        });
        expect((await runtime.enqueueIfAbsent(late)).verdict.kind).toBe('pending');

        const again = await runtime.enqueueIfAbsent(late);

        expect(again.verdict.kind).toBe('pending');
        expect(again.message.ordering?.seq).toBeUndefined();
        expect(again.entries).toHaveLength(1);
        expect(decodePersistedALMessage(again.entries[0]!.resource).ordering).toEqual({ orderingKey: 'game-1', epoch: 1 });
    });

    it('mints nothing for a plan that does not ask for a sequence', async () => {
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createRoundEvent('keyed-unsequenced', { orderingKey: 'game-1', epoch: 1 });

        const result = await runtime.enqueueIfAbsent(message);

        expect(result.verdict.kind).toBe('admitted');
        expect(result.message.ordering?.seq).toBeUndefined();
        expect((await stores.admissionStore.readSentMessage(message.id.msgId))?.msg.ordering?.seq).toBeUndefined();
    });
});

describe('the browser minting plan', () => {
    const base: ALOutboundDispatchPlan<OutboundTestPayload> = {
        msg: createRoomSend('base', {}),
        dropReasonCode: undefined,
        lane: 'volatile',
        preparedMessages: []
    };

    it.each([
        { name: 'a key alone', ordering: { orderingKey: 'chat' } },
        { name: 'a key beside an application sequence', ordering: { orderingKey: 'chat', seq: 7 } }
    ])('owns the track of an own room send naming $name on the durable lane at its admission', ({ ordering }) => {
        const plan = { ...base, msg: createRoomSend('keyed', ordering) };

        expect(toALOutboundMintingPlan(plan, 'admission', BROWSER_SESSION_ID)).toEqual({
            ...plan,
            mintsSequence: true,
            lane: 'durable'
        });
    });

    it.each(['replan', 'dequeue', 'hand-over'] as const)('leaves a plan at stage %s as it is', (stage) => {
        const plan = { ...base, msg: createRoomSend('keyed', { orderingKey: 'chat' }) };

        expect(toALOutboundMintingPlan(plan, stage, BROWSER_SESSION_ID)).toBe(plan);
    });

    it('leaves an unkeyed send, a world broadcast, a relayed frame and a dropping plan as they are', () => {
        const world = newALBroadcastMessage(
            BROWSER_SESSION_ID,
            newALRoute('app.chat', 'world', 'world-keyed'),
            'world',
            'app.chat.v1',
            {},
            { ordering: { orderingKey: 'chat' } }
        );
        const plans = [
            base,
            { ...base, msg: world },
            { ...base, msg: { ...createRoomSend('relayed', { orderingKey: 'chat' }), id: { ...base.msg.id, senderId: 'b' } } },
            { ...base, msg: createRoomSend('dropped', { orderingKey: 'chat' }), dropReasonCode: 'no-route' as const }
        ];

        for (const plan of plans) {
            expect(toALOutboundMintingPlan(plan, 'admission', BROWSER_SESSION_ID)).toBe(plan);
        }
    });
});

describe('a browser room send that asks its outbound for a sequence', () => {
    it('is admitted durable, and its minted track continues where the store stands after a reload', async () => {
        const stores = createDefaultOutboundTestStores();
        const page = createBrowserMintingRuntime(stores);
        const first = await page.enqueueIfAbsent(createRoomSend('before-1', { orderingKey: 'chat' }));
        await page.enqueueIfAbsent(createRoomSend('before-2', { orderingKey: 'chat' }));
        await page.dispose();

        const reloaded = createBrowserMintingRuntime(stores);
        const after = await reloaded.enqueueIfAbsent(createRoomSend('after', { orderingKey: 'chat' }));

        expect(first.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(first.message.ordering?.seq).toBe(1);
        expect(after.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(after.message.ordering?.seq).toBe(3);
    });

    it('refuses an application sequence at or below the head as unsupported, and moves the head to one above it', async () => {
        const runtime = createBrowserMintingRuntime(createDefaultOutboundTestStores());
        await runtime.enqueueIfAbsent(createRoomSend('minted-1', { orderingKey: 'chat' }));
        await runtime.enqueueIfAbsent(createRoomSend('minted-2', { orderingKey: 'chat' }));

        const repeated = await runtime.enqueueIfAbsent(createRoomSend('stated-2', { orderingKey: 'chat', seq: 2 }));
        const below = await runtime.enqueueIfAbsent(createRoomSend('stated-1', { orderingKey: 'chat', seq: 1 }));
        const forced = await runtime.enqueueIfAbsent(createRoomSend('stated-300', { orderingKey: 'chat', seq: 300 }));
        const next = await runtime.enqueueIfAbsent(createRoomSend('minted-301', { orderingKey: 'chat' }));

        expect(repeated.verdict).toMatchObject({ kind: 'refused', reason: 'unsupported' });
        expect(below.verdict).toMatchObject({ kind: 'refused', reason: 'unsupported' });
        expect(forced.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(forced.message.ordering?.seq).toBe(300);
        expect(next.message.ordering?.seq).toBe(301);
    });

    it('keeps the head and each sent position for the repository TTL, past a shorter sent-row TTL', () => {
        const nowMs = 1_700_000_000_000;
        const mutations = new ALOutboundAdmissionMutations({
            namespace: 'outbound-test',
            orderingHeadNamespace: 'outbound-test',
            canonicalScope: 'outbound-test',
            retention: normalizeALRuntimeStoreRetention({ sentMessageTtlMs: 60_000 }),
            supersedenceTrackTtlMs: 60_000,
            durability: 'durable'
        });

        const writes = mutations.computeStateWrites([
            {
                kind: 'set-ordering-head',
                trackKey: 'chat:session-a:0',
                seq: 3,
                observedSeq: 2,
                expireAtTimestamp: nowMs + 1_000
            },
            {
                kind: 'set-sent-position',
                namespace: 'pair',
                trackKey: 'chat:session-a:0',
                recipientPeerId: 'b',
                seq: 3,
                expireAtTimestamp: nowMs + 1_000
            }
        ], nowMs);

        expect(writes.map((write) => write.expireAtTimestamp)).toEqual([
            nowMs + DEFAULT_AL_REPOSITORY_TTL_MS,
            nowMs + DEFAULT_AL_REPOSITORY_TTL_MS
        ]);
    });
});

describe('the room-wide sent position a mint moves', () => {
    const plan: ALOutboundDispatchPlan<OutboundTestPayload> = {
        msg: createRoomSend('room-position', { orderingKey: 'chat' }),
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [],
        mintsSequence: true
    };

    const observed = { unreceiptedSeq: 2, pendingReceiptSeqs: [4] };
    const receipting = {
        enabled: true,
        timeoutMs: 1_000,
        maxAttempts: 0,
        expectedPeerIds: ['server'],
        nextHopPeerIds: ['server'],
        mode: 'receiver'
    } as const;

    it.each([
        {
            label: 'a send recording no recipient that asks for no receipt',
            sharesHead: true,
            records: false,
            ackTracking: undefined,
            moved: { observed, value: { unreceiptedSeq: 5, pendingReceiptSeqs: [] } }
        },
        {
            label: 'a send recording no recipient whose receipt will name them',
            sharesHead: true,
            records: false,
            ackTracking: receipting,
            moved: { observed, value: { unreceiptedSeq: 2, pendingReceiptSeqs: [4, 5] } }
        },
        {
            label: 'a send recording no recipient whose receipt only counts hops',
            sharesHead: true,
            records: false,
            ackTracking: { ...receipting, mode: 'hop' as const },
            moved: { observed, value: { unreceiptedSeq: 5, pendingReceiptSeqs: [] } }
        },
        { label: 'a send recording its recipients', sharesHead: true, records: true, ackTracking: undefined, moved: undefined },
        { label: 'a pair\'s own head', sharesHead: false, records: false, ackTracking: undefined, moved: undefined }
    ])('is moved for $label', ({ sharesHead, records, ackTracking, moved }) => {
        const minted = computeALOutboundSequenceMint({
            plan: { ...plan, ackTracking, ...(records ? { recordsSentPositions: ['b'] } : {}) },
            trackKey: 'chat',
            head: { seq: 4 },
            roomPosition: observed,
            sharesHead
        });

        expect(minted.orderingHead).toEqual({ trackKey: 'chat', seq: 5, observedSeq: 4, roomSentPosition: moved });
    });
});

function createRoomSend(name: string, ordering: Readonly<{ orderingKey?: string; seq?: number; }>): ALMessage {
    return newALMulticastMessage(
        BROWSER_SESSION_ID,
        newALRoute('room.chat', ROOM.groupId, name),
        ROOM,
        'room.chat.v1',
        { name },
        { ttlMs: ROUND_EVENT_TTL_MS, ...ordering }
    );
}

/** A page's carrier runtime: its durable pair outlives the page, its memory pair does not. */
function createBrowserMintingRuntime(stores: OutboundTestStores): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores,
        volatileStores: createVolatileOutboundTestStores(),
        planOutgoingMessage: BROWSER_MINTING_PLANNER,
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
}

function createRoundEvent(name: string, ordering: Readonly<{ orderingKey: string; epoch: number; }>): ALMessage {
    return newALBroadcastMessage(
        'server',
        newALRoute('room.app.event', ROOM.groupId, name),
        'room',
        'app.event.v1',
        { name },
        { groupRef: ROOM, ttlMs: ROUND_EVENT_TTL_MS, ordering }
    );
}

function createMintingRuntime(stores: OutboundTestStores): MintingRuntime {
    const sent: ALMessage[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: MINTING_PLANNER,
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { runtime, sent };
}

async function enqueueMintedSeq(
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
    message: ALMessage
): Promise<number | undefined> {
    const result = await runtime.enqueueIfAbsent(message);
    expect(result.verdict.kind).toBe('admitted');
    return result.message.ordering?.seq;
}

/**
 * Lets `interleaved` commit right after the next decision read, so that read's commit finds the sender moved.
 * It commits through the store, as another instance would: a second runtime here would wait on the sender's lock.
 */
function interleaveAfterFirstDecisionRead(stores: OutboundTestStores, interleaved: () => Promise<void>): void {
    const store = stores.admissionStore;
    const readOutgoingDecision = store.readOutgoingDecision.bind(store);
    vi.spyOn(store, 'readOutgoingDecision').mockImplementationOnce(async (input, decide) => {
        const observed = await readOutgoingDecision(input, decide);
        await interleaved();
        return observed;
    });
}

/** A clock that moves only when the test moves it, for every reader of the current time. */
function mockClock(): { nowMs: number; } {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    return clock;
}

/** The canonical row the outbound keeps for a message: a retained admission's before its replay, the admitted one after. */
async function readCanonicalMessage(stores: OutboundTestStores, message: ALMessage): Promise<ALMessage> {
    const entry = await stores.workQueue.getItem(toALOutboundCanonicalKey(stores.admissionStore.canonicalScope, message));
    if (entry === undefined) {
        throw new Error(`Expected a canonical row for ${message.id.msgId}`);
    }
    return decodePersistedALMessage(entry.resource);
}
