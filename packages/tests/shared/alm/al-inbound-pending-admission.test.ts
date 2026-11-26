import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultInMemoryALInboundRuntimeStores,
    createVolatileALInboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundCommitBundle } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import { ALInboundMessageRuntime, type ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALInboundWorkEntry, type ALPersistedInboundEffect } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    loseInboundWritesFromNowOn,
    restoreInboundWritesOnRetention,
    setNextInboundAdmissionParked,
    type CreateInboundTestRuntimeInput,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import '../../setup-browser-indexeddb.ts';

import { AL_GAP_NACK_RELAY_HOP_LIMIT } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toTestALAckPayload } from '../../al-control-test-payloads.ts';

const PENDING_SOURCE: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: 'sender' };
/** The audience a replay's authority answers with: the source it ran under differs from the one the message was kept under. */
const NARROWED_AUDIENCE = { groupRecipientPeerIds: ['sender', 'receiver'], snapshotVersion: 7 };

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it.each(['memory', 'indexeddb'] as const)(
    'retains a real conditional conflict and recovers once after %s restart with the original deadline',
    async (backend) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const options = { dbName: `pending-${crypto.randomUUID()}`, namespace: 'pending-inbound' };
        const stores = backend === 'memory' ? createDefaultInMemoryALInboundRuntimeStores(options) : createDefaultIndexedDbALInboundRuntimeStores(options);
        const fixture = await retainConflictedAdmission(stores);
        expect(fixture.work.payload).toMatchObject({ kind: 'admit-message', source: { kind: 'rtc-peer', peerId: 'sender' } });
        expect(fixture.work.expireAtTimestamp).toBe(Date.now() + 1_000);
        expect(fixture.work.entry.status).toBe(EntityStatus.NEW);
        const restartedStores = backend === 'memory' ? stores : createDefaultIndexedDbALInboundRuntimeStores(options);
        const delivered: ALMessage[] = [];
        const controls: ALMessage[] = [];
        const dependencies = runtimeDependencies(restartedStores, delivered, controls);
        const restarted = new ALInboundMessageRuntime(dependencies);
        onTestFinished(() => restarted.dispose());
        await restarted.ready();
        await expect.poll(async () => {
            await dependencies.queueEngine.executeOnce();
            return delivered.length;
        }).toBe(1);
        expect(delivered[0].constraints?.expiresAtMs).toBe(fixture.work.expireAtTimestamp);
        await expect.poll(async () => {
            await dependencies.queueEngine.executeOnce();
            return controls.length;
        }).toBe(1);
        const completed = await restartedStores.workQueue.getItem(fixture.work.entry.key);
        expect(completed?.status).toBe(EntityStatus.COMPLETED);
        // Recovery followed by a normal duplicate cannot dispatch another copy.
        const duplicate = await restarted.admitIncomingMessage(fixture.message, { kind: 'rtc-peer', peerId: 'sender' });
        expect(duplicate.right?.kind).toBe('duplicate');
        expect(delivered).toHaveLength(1);
    }
);

it('retains a message its ingress authority is behind on to its deadline and admits it once that authority catches up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const dependencies = runtimeDependencies(stores, delivered, controls);
    let behind = true;
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        readPendingAdmissionAuthority: async (_msg, source) => behind ? { kind: 'retry', retryAfterMs: 50 } : { kind: 'authorized', source },
        diagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => runtime.dispose());
    const message = newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'sender',
        route: { topicId: 'chat', resourceId: 'message', contextId: 'room' },
        toPeerId: 'receiver',
        typeId: 'chat',
        resource: {},
        options: {
            ttlMs: 60_000
        }
    });

    expect(await runtime.retainIncomingMessage(message, PENDING_SOURCE)).toEqual({ kind: 'pending-admission' });
    expect(diagnostics).toContainEqual(expect.objectContaining({
        kind: 'admission-outcome',
        msgId: message.id.msgId,
        outcome: 'pending',
        reason: 'pending-admission'
    }));
    const keys = await stores.workQueue.getAllKeys();
    expect(keys).toHaveLength(1);
    const work = decodeALInboundWorkEntry((await stores.workQueue.getItem(keys[0]))!, stores.admissionStore.namespace);
    expect(work.payload).toMatchObject({ kind: 'admit-message', source: PENDING_SOURCE });
    expect(work.expireAtTimestamp).toBe(message.constraints?.expiresAtMs);
    for (let pass = 0; pass < 4; pass++) {
        await dependencies.queueEngine.executeOnce();
    }
    expect(delivered).toEqual([]);

    behind = false;
    vi.setSystemTime(Date.now() + 50);
    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return delivered.length;
    }).toBe(1);
    expect(delivered[0].id).toEqual(message.id);
    for (let pass = 0; pass < 4; pass++) {
        await dependencies.queueEngine.executeOnce();
    }
    expect(delivered).toHaveLength(1);
});

it('hands a kept message its replay admits to its owner once, under the authority the replay ran with and the source it was kept under, before the delivery it wrote runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const delivered: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, []);
    const handOvers = recordHandOvers(delivered);
    let behind = true;
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        readPendingAdmissionAuthority: async (_msg, source) =>
            behind ? { kind: 'retry', retryAfterMs: 50 } : { kind: 'authorized', source: { ...source, ...NARROWED_AUDIENCE }, snapshotVersion: 7 },
        onReplayAdmitted: handOvers.onReplayAdmitted,
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    const message = newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'sender',
        route: { topicId: 'chat', resourceId: 'message', contextId: 'room' },
        toPeerId: 'receiver',
        typeId: 'chat',
        resource: {},
        options: { ttlMs: 60_000 }
    });
    expect(await runtime.retainIncomingMessage(message, PENDING_SOURCE)).toEqual({ kind: 'pending-admission' });
    for (let pass = 0; pass < 4; pass++) {
        await dependencies.queueEngine.executeOnce();
    }
    expect(handOvers.handedOver).toEqual([]);

    behind = false;
    vi.setSystemTime(Date.now() + 50);
    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return delivered.length;
    }).toBe(1);
    for (let pass = 0; pass < 4; pass++) {
        await dependencies.queueEngine.executeOnce();
    }
    expect(handOvers.handedOver).toEqual([{
        msg: expect.objectContaining({ id: message.id, constraints: { expiresAtMs: message.constraints?.expiresAtMs } }),
        source: { ...PENDING_SOURCE, ...NARROWED_AUDIENCE },
        pendingSource: PENDING_SOURCE,
        snapshotVersion: 7,
        deliveredBefore: 0
    }]);
});

it('hands over a message kept after a lost commit race, with no snapshot version when no authority is configured', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    await retainConflictedAdmission(stores);
    const delivered: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, []);
    const handOvers = recordHandOvers(delivered);
    const runtime = new ALInboundMessageRuntime({ ...dependencies, onReplayAdmitted: handOvers.onReplayAdmitted });
    onTestFinished(() => runtime.dispose());
    await runtime.ready();

    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return delivered.length;
    }).toBe(1);

    expect(handOvers.handedOver).toEqual([{
        msg: expect.objectContaining({ id: delivered[0].id }),
        source: { kind: 'rtc-peer', peerId: 'sender' },
        pendingSource: { kind: 'rtc-peer', peerId: 'sender' },
        snapshotVersion: undefined,
        deliveredBefore: 0
    }]);
});

it('a hand-over that rejects leaves the message delivered once and is not made again', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    await retainConflictedAdmission(stores);
    const delivered: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, []);
    const handOvers = recordHandOvers(delivered);
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        onReplayAdmitted: async (admitted) => {
            await handOvers.onReplayAdmitted(admitted);
            throw new Error('receipt store unavailable');
        }
    });
    onTestFinished(() => runtime.dispose());
    await runtime.ready();

    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return [delivered.length, await readRetainedAdmissionStatus(stores)];
    }).toEqual([1, EntityStatus.COMPLETED]);

    expect(handOvers.handedOver).toHaveLength(1);
    expect(delivered).toHaveLength(1);
});

/** Runs its replay to the status the row reaches without a hand-over, and returns its stores. */
type ReplayThatHandsNothingOver = (onReplayAdmitted: ALInboundMessageRuntime.Dependencies['onReplayAdmitted']) => Promise<ALInboundRuntimeStores>;

/** These never reach an authorized replay, so they hand nothing over whatever the replay does once authorized. */
const REPLAYS_REFUSED_BEFORE_AUTHORITY: readonly (readonly [string, EntityStatus | undefined, ReplayThatHandsNothingOver])[] = [
    ['an authority that refuses', EntityStatus.COMPLETED, async (onReplayAdmitted) => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        await retainConflictedAdmission(stores);
        const dependencies = runtimeDependencies(stores, [], []);
        const runtime = new ALInboundMessageRuntime({
            ...dependencies,
            readPendingAdmissionAuthority: async () => ({ kind: 'rejected' }),
            onReplayAdmitted
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        await runUntilRetainedStatus(dependencies.queueEngine, stores, EntityStatus.COMPLETED);
        return stores;
    }],
    ['a deadline that has passed', undefined, async (onReplayAdmitted) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const fixture = await retainConflictedAdmission(stores);
        vi.setSystemTime(fixture.work.expireAtTimestamp);
        const dependencies = runtimeDependencies(stores, [], []);
        const runtime = new ALInboundMessageRuntime({ ...dependencies, onReplayAdmitted });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        await runUntilRetainedStatus(dependencies.queueEngine, stores, undefined);
        return stores;
    }]
];

const REPLAYS_THAT_HAND_NOTHING_OVER: readonly (readonly [string, EntityStatus | undefined, ReplayThatHandsNothingOver])[] = [
    ['a plan that drops the message', EntityStatus.COMPLETED, async (onReplayAdmitted) => {
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        await retainConflictedAdmission(stores);
        const dependencies = runtimeDependencies(stores, [], []);
        const runtime = new ALInboundMessageRuntime({
            ...dependencies,
            planIncomingMessage: (msg, source, observations) => ({
                ...dependencies.planIncomingMessage(msg, source, observations),
                dropReason: 'Room authorization was revoked'
            }),
            onReplayAdmitted
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        await runUntilRetainedStatus(dependencies.queueEngine, stores, EntityStatus.COMPLETED);
        return stores;
    }],
    ['a copy admitted before it', EntityStatus.COMPLETED, async (onReplayAdmitted) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const delivered: ALMessage[] = [];
        const dependencies = runtimeDependencies(stores, delivered, []);
        let behind = true;
        const runtime = new ALInboundMessageRuntime({
            ...dependencies,
            readPendingAdmissionAuthority: async (_msg, source) => behind ? { kind: 'retry', retryAfterMs: 50 } : { kind: 'authorized', source },
            onReplayAdmitted
        });
        onTestFinished(() => runtime.dispose());
        const message = newALUnicastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'sender',
            route: { topicId: 'chat', resourceId: 'message', contextId: 'room' },
            toPeerId: 'receiver',
            typeId: 'chat',
            resource: {},
            options: { ttlMs: 60_000 }
        });
        expect(await runtime.retainIncomingMessage(message, PENDING_SOURCE)).toEqual({ kind: 'pending-admission' });
        expect((await runtime.admitIncomingMessage(message, PENDING_SOURCE)).right).toEqual({ kind: 'admitted' });
        behind = false;
        vi.setSystemTime(Date.now() + 50);
        await runUntilRetainedStatus(dependencies.queueEngine, stores, EntityStatus.COMPLETED);
        expect(delivered).toHaveLength(1);
        return stores;
    }],
    ['a commit that conflicts again', EntityStatus.RETRY, async (onReplayAdmitted) => {
        let authorityReads = 0;
        const { fixture } = await startReplayThatConflictsAgain({
            // The first replay runs its attempt; every later one is held, so the row is read before its second replay.
            readPendingAdmissionAuthority: async (_msg, source) => {
                authorityReads++;
                return authorityReads === 1 ? { kind: 'authorized', source } : { kind: 'retry', retryAfterMs: 60_000 };
            },
            onReplayAdmitted
        });
        await expect.poll(async () => {
            await fixture.queueEngine.executeOnce();
            return authorityReads;
        }).toBeGreaterThan(1);
        return fixture.stores;
    }],
    ['a shutdown before its verdict', EntityStatus.RETRY, async (onReplayAdmitted) => {
        const { fixture } = await runReplayThatShutdownCutsShort(onReplayAdmitted);
        return fixture.stores;
    }]
];

async function expectNothingHandedOver(status: EntityStatus | undefined, arrange: ReplayThatHandsNothingOver): Promise<void> {
    const handOvers = recordHandOvers([]);

    const stores = await arrange(handOvers.onReplayAdmitted);

    expect(await readRetainedAdmissionStatus(stores)).toBe(status);
    expect(handOvers.handedOver).toEqual([]);
}

it.each(REPLAYS_REFUSED_BEFORE_AUTHORITY)('characterization: hands nothing over when the replay meets %s', async (_replay, status, arrange) => {
    await expectNothingHandedOver(status, arrange);
});

it.each(REPLAYS_THAT_HAND_NOTHING_OVER)('hands nothing over when the replay meets %s', async (_replay, status, arrange) => {
    await expectNothingHandedOver(status, arrange);
});

it.each(['authority', 'deadline'] as const)('checks current %s before admitting retained pending work', async (boundary) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const fixture = await retainConflictedAdmission(stores);
    if (boundary === 'deadline') {
        vi.setSystemTime(fixture.work.expireAtTimestamp);
    }
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, controls);
    const planner = vi.fn<ALInboundMessageRuntime.Dependencies['planIncomingMessage']>((msg, source, observations) => {
        const current = dependencies.planIncomingMessage(msg, source, observations);
        return boundary === 'authority' ? { ...current, dropReason: 'Room authorization was revoked' } : current;
    });
    const restarted = new ALInboundMessageRuntime({ ...dependencies, planIncomingMessage: planner, diagnostics: undefined });
    onTestFinished(() => restarted.dispose());
    await restarted.ready();
    if (boundary === 'authority') {
        expect(planner).toHaveBeenCalled();
    }
    for (let pass = 0; pass < 4; pass++) {
        await dependencies.queueEngine.executeOnce();
    }
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
});

it('refuses to report pending when an existing admission attempt completed after authority revocation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const fixture = await retainConflictedAdmission(stores);
    if (fixture.work.payload.kind !== 'admit-message') {
        throw new Error('Expected pending admission');
    }
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, controls);
    const restarted = new ALInboundMessageRuntime({
        ...dependencies,
        readPendingAdmissionAuthority: async () => ({ kind: 'rejected' }),
        diagnostics: undefined
    });
    onTestFinished(() => restarted.dispose());
    await restarted.ready();
    const terminal = await stores.workQueue.getItem(fixture.work.entry.key);
    expect(terminal?.status).toBe(EntityStatus.COMPLETED);
    const nowMs = Date.now();
    const prePlan = dependencies.planIncomingMessage(fixture.message, fixture.work.payload.source, { nowMs });
    const admissionRead = await stores.admissionStore.readIncomingMessage({
        selfPeerId: 'receiver',
        orderingObserver: 'addressed',
        msg: fixture.message,
        source: fixture.work.payload.source,
        nowMs,
        prePlan
    });
    expect(admissionRead.dedupExpiresAt).toBeUndefined();

    const admission = new ALInboundMessageAdmission({
        ...dependencies,
        gapRenewalStretch: 1,
        workPort: createTestALInboundWorkPort({ carrier: 'rtc', ...stores, nowMs: Date.now })
    });
    onTestFinished(() => admission.dispose());
    expect(await admission.retainPending(fixture.work.payload)).toMatchObject({ kind: 'not-admitted' });
    expect(await stores.workQueue.getItem(fixture.work.entry.key)).toEqual(terminal);
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
});

it.each(['payload', 'scope', 'deadline'] as const)('refuses a conflicting pending %s observation at the existing QueueBox slot', async (field) => {
    const stores = createDefaultIndexedDbALInboundRuntimeStores({ dbName: `pending-conflict-${crypto.randomUUID()}`, namespace: 'full-scope' });
    const fixture = await retainConflictedAdmission(stores);
    if (fixture.work.payload.kind !== 'admit-message') {
        throw new Error('Expected pending admission');
    }
    const before = await stores.workQueue.getItem(fixture.work.entry.key);
    const pending = fixture.work.payload;
    const admission = new ALInboundMessageAdmission({
        ...runtimeDependencies(stores, [], []),
        gapRenewalStretch: 1,
        workPort: createTestALInboundWorkPort({ carrier: 'rtc', ...stores, nowMs: Date.now })
    });
    if (field === 'scope') {
        const resource = JSON.stringify({ ...JSON.parse(fixture.work.entry.resource), namespace: 'other-full-scope' });
        await stores.workQueue.enqueue({ ...fixture.work.entry, resource });
        await expect(admission.retainPending(pending)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect((await stores.workQueue.getItem(fixture.work.entry.key))?.resource).toBe(resource);
        return;
    }
    const candidate = field === 'payload'
        ? { ...pending, msg: { ...pending.msg, payload: { ...pending.msg.payload, resource: '{"changed":true}' } } }
        : { ...pending, msg: { ...pending.msg, constraints: { ...pending.msg.constraints, expiresAtMs: fixture.work.expireAtTimestamp + 1 } } };
    await expect(admission.retainPending(candidate)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    expect(await stores.workQueue.getItem(fixture.work.entry.key)).toEqual(before);
});

it('answers the same pending message from another source as retained, keeping the first source', async () => {
    const stores = createDefaultIndexedDbALInboundRuntimeStores({ dbName: `pending-source-${crypto.randomUUID()}`, namespace: 'full-scope' });
    const fixture = await retainConflictedAdmission(stores);
    if (fixture.work.payload.kind !== 'admit-message') {
        throw new Error('Expected pending admission');
    }
    const before = await stores.workQueue.getItem(fixture.work.entry.key);
    const admission = new ALInboundMessageAdmission({
        ...runtimeDependencies(stores, [], []),
        gapRenewalStretch: 1,
        workPort: createTestALInboundWorkPort({ carrier: 'ws', ...stores, nowMs: Date.now })
    });
    onTestFinished(() => admission.dispose());

    expect(await admission.retainPending({ ...fixture.work.payload, source: { kind: 'trusted-server' } })).toEqual({ kind: 'pending-admission' });
    expect(await stores.workQueue.getItem(fixture.work.entry.key)).toEqual(before);
});

it('never retains malformed, forged, unknown-control or planner-rejected ingress', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, controls);
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        planIncomingMessage: (msg, source, observations) => ({
            ...dependencies.planIncomingMessage(msg, source, observations),
            dropReason: 'Room authorization was revoked'
        }),
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    const message = newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'sender',
        route: { topicId: 'chat', resourceId: 'message', contextId: 'room' },
        toPeerId: 'receiver',
        typeId: 'chat',
        resource: {}
    });
    const untrackedAck = newALAckControlMessage(
        {
            v: 4,
            senderId: 'sender',
            msgId: 'unknown-control',
            ts: Date.now(),
            traceId: 'trace-al-inbound-pending-admission'
        },
        toTestALAckPayload({
            ackedMsgId: 'unknown',
            originPeerId: 'receiver',
            logicalRecipientPeerId: 'sender',
            fromPeerId: 'sender',
            toPeerId: 'receiver',
            status: 'delivered',
            observedAtEpochMs: Date.now(),
            carrier: 'rtc'
        })
    );
    const source = { kind: 'rtc-peer' as const, peerId: 'sender' };
    const malformed = await runtime.admitIncomingMessage({}, { kind: 'trusted-server' });
    expect(malformed.left).toMatchObject({ code: 'malformed' });
    const forged = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: 'forger' });
    expect(forged.left).toMatchObject({ code: 'unauthorized' });
    const unknownControl = await runtime.admitIncomingMessage(untrackedAck, source);
    expect(unknownControl.right).toEqual({ kind: 'control', handled: false });
    const rejected = await runtime.admitIncomingMessage(message, source);
    expect(rejected.right).toEqual({ kind: 'not-admitted', reason: 'Room authorization was revoked' });

    const nowMs = Date.now();
    const read = await stores.admissionStore.readIncomingMessage({
        selfPeerId: 'receiver',
        orderingObserver: 'addressed',
        msg: message,
        source,
        nowMs,
        prePlan: dependencies.planIncomingMessage(message, source, { nowMs })
    });
    expect(read.observations).toMatchObject({
        messageOwner: undefined,
        dedup: { expiresAtTimestamp: undefined },
        pendingAck: undefined,
        acks: [],
        controlOwners: undefined
    });
    expect(await stores.workQueue.getAllKeys()).toEqual([]);
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
});

it('replays a retained conflict in the batch an idle owner runs on its own commit', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const runtime = new ALInboundMessageRuntime(runtimeDependencies(stores, [], []));
    onTestFinished(() => runtime.dispose());
    await runtime.ready();

    // Every attempt's write is lost, so the arrival is parked whatever number of attempts its owner makes.
    restoreInboundWritesOnRetention(stores, setNextInboundAdmissionParked(stores.admissionStore));
    const acceptance = await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'idle-owner' }), PENDING_SOURCE);

    expect(acceptance.right).toEqual({ kind: 'pending-admission' });
    // The engine is never started and no round is ever executed here, so the batch the commit itself
    // runs is the only thing that can have claimed the retained row.
    await expect.poll(() => readRetainedAdmissionStatus(stores)).toBe(EntityStatus.COMPLETED);
});

it('replays a retained conflict in a batch the handler runs after the one already running', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const dependencies = runtimeDependencies(stores, [], []);
    const dispatching = Promise.withResolvers<void>();
    let dispatchStarted = false;
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        dispatchInboxEntry: async (entry, plan, source) => {
            dispatchStarted = true;
            await dispatching.promise;
            return await dependencies.dispatchInboxEntry(entry, plan, source);
        }
    });
    onTestFinished(() => {
        dispatching.resolve();
        return runtime.dispose();
    });
    await runtime.ready();
    // The first message's own commit starts a batch and holds it inside the delivery it claimed.
    expect((await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'running-blocker' }), PENDING_SOURCE)).right)
        .toEqual({ kind: 'admitted' });
    await expect.poll(() => dispatchStarted).toBe(true);

    // Every attempt's write is lost, so the arrival is parked whatever number of attempts its owner makes.
    restoreInboundWritesOnRetention(stores, setNextInboundAdmissionParked(stores.admissionStore));
    const acceptance = await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'running-conflict' }), PENDING_SOURCE);

    expect(acceptance.right).toEqual({ kind: 'pending-admission' });
    // The running batch claimed its page before this row existed, so nothing has claimed it yet.
    expect(await readRetainedAdmissionStatus(stores)).toBe(EntityStatus.NEW);

    dispatching.resolve();

    await expect.poll(() => readRetainedAdmissionStatus(stores)).toBe(EntityStatus.COMPLETED);
});

it('retains a resync-required drop whose commit conflicted, and its replay commits the drop with its one NACK', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, controls);
    const runtime = new ALInboundMessageRuntime(dependencies);
    onTestFinished(() => runtime.dispose());
    await runtime.ready();
    expect((await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'track-first', seq: 1 }), PENDING_SOURCE)).right)
        .toEqual({ kind: 'admitted' });
    // The first send's own batch settles first, so the only write under the gapped send is the next send's commit.
    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return delivered.length;
    }).toBe(1);

    // The next send of the track commits between the gapped send's read and its write, as two frames of one socket do;
    // every later attempt's write of the gapped send is lost too, so it is parked however often its owner looks again.
    const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
    vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        expect((await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'track-next', seq: 2 }), PENDING_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        restoreInboundWritesOnRetention(stores, loseInboundWritesFromNowOn(stores.admissionStore));
        return await commitBundle(bundle);
    });
    const gapped = await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'track-gapped', seq: 300 }), PENDING_SOURCE);

    expect(gapped.right).toEqual({ kind: 'pending-admission' });
    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return toSentNackResources(controls).length;
    }).toBe(1);
    for (let pass = 0; pass < 4; pass++) {
        await dependencies.queueEngine.executeOnce();
    }
    expect(toSentNackResources(controls)).toEqual([expect.objectContaining({ msgId: 'track-gapped', reason: 'resync-required' })]);
    expect(await readRetainedAdmissionStatus(stores)).toBe(EntityStatus.COMPLETED);
});

it('answers a drop that owes nothing with its own reason when its track moved under it: an empty bundle never meets the fence', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const dependencies = runtimeDependencies(stores, [], []);
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        planIncomingMessage: (msg, source, observations) => ({
            ...dependencies.planIncomingMessage(msg, source, observations),
            dropReason: 'Room authorization was revoked'
        })
    });
    onTestFinished(() => runtime.dispose());
    await runtime.ready();
    const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
    const dropped: ALInboundCommitBundle[] = [];
    // Another send of the same track commits between the dropped send's read and its write.
    vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        dropped.push(bundle);
        const competing = await createInboundTestAdmission(stores)
            .attempt(createInboundTestMessage({ msgId: 'track-winner', seq: 1 }), PENDING_SOURCE, dependencies.planIncomingMessage);
        expect(competing.right).toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        return await commitBundle(bundle);
    });

    const acceptance = await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'owed-nothing', seq: 1 }), PENDING_SOURCE);

    expect(dropped.map((bundle) => [bundle.mutations, bundle.durableEffects])).toEqual([[[], []]]);
    expect(acceptance.right).toEqual({ kind: 'not-admitted', reason: 'Room authorization was revoked' });
    expect(await readRetainedAdmissionStatus(stores)).toBeUndefined();
});

it('a drop retained on a commit conflict states pending first and its replay\'s drop second, under one msgId and trace', async () => {
    const stores = createDefaultInMemoryALInboundRuntimeStores();
    const controls: ALMessage[] = [];
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const dependencies = runtimeDependencies(stores, [], controls);
    const runtime = new ALInboundMessageRuntime({ ...dependencies, diagnostics: (event) => diagnostics.push(event) });
    onTestFinished(() => runtime.dispose());
    await runtime.ready();
    expect((await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'track-first', seq: 1 }), PENDING_SOURCE)).right)
        .toEqual({ kind: 'admitted' });
    // The next send of the track commits inside the gapped send's write, and every later attempt's write of the gapped
    // send is lost, so it is retained however often its owner looks again.
    const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
    vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        await runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'track-next', seq: 2 }), PENDING_SOURCE);
        restoreInboundWritesOnRetention(stores, loseInboundWritesFromNowOn(stores.admissionStore));
        return await commitBundle(bundle);
    });
    const gapped = createInboundTestMessage({ msgId: 'track-gapped', seq: 300, traceId: 'trace-track-gapped' });

    expect((await runtime.admitIncomingMessage(gapped, PENDING_SOURCE)).right).toEqual({ kind: 'pending-admission' });
    await expect.poll(async () => {
        await dependencies.queueEngine.executeOnce();
        return toSentNackResources(controls).length;
    }).toBe(1);

    expect(toAdmissionOutcomes(diagnostics, gapped)).toEqual([
        { workerId: dependencies.effectWorkerId, outcome: 'pending', reason: 'pending-admission', traceId: 'trace-track-gapped', corrId: 'track-gapped' },
        { workerId: dependencies.effectWorkerId, outcome: 'not-handled', reason: 'resync-required', traceId: 'trace-track-gapped', corrId: 'track-gapped' }
    ]);
});

it('a replay that admits states committed / admitted', async () => {
    const { runtime, stores, diagnostics, delivered } = createInboundTestRuntime({
        carrier: 'rtc',
        stores: createDefaultInMemoryALInboundRuntimeStores(),
        effectWorkerId: 'replay-admits-worker'
    });
    await runtime.ready();
    const message = createInboundTestMessage({ msgId: 'replay-admits', traceId: 'trace-replay-admits' });
    // Every attempt's write of the arrival is lost, so it is retained and only its replay can admit it.
    restoreInboundWritesOnRetention(stores, setNextInboundAdmissionParked(stores.admissionStore));

    expect((await runtime.admitIncomingMessage(message, PENDING_SOURCE)).right).toEqual({ kind: 'pending-admission' });
    await expect.poll(() => delivered).toEqual(['dispatched']);

    expect(toAdmissionOutcomes(diagnostics, message)).toEqual([
        { workerId: 'replay-admits-worker', outcome: 'pending', reason: 'pending-admission', traceId: 'trace-replay-admits', corrId: 'replay-admits' },
        { workerId: 'replay-admits-worker', outcome: 'committed', reason: 'admitted', traceId: 'trace-replay-admits', corrId: 'replay-admits' }
    ]);
});

it('a diagnostics sink that throws leaves a replay\'s delivery and its claim unchanged', async () => {
    const deliveredWith = async (diagnostics: ALInboundMessageRuntime.Dependencies['diagnostics']) => {
        const delivered: ALMessage[] = [];
        const stores = createDefaultInMemoryALInboundRuntimeStores();
        const dependencies = runtimeDependencies(stores, delivered, []);
        const runtime = new ALInboundMessageRuntime({ ...dependencies, diagnostics });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        const message = createInboundTestMessage({ msgId: 'replay-sink-throws' });
        // Every attempt's write of the arrival is lost, so only its replay delivers it.
        restoreInboundWritesOnRetention(stores, setNextInboundAdmissionParked(stores.admissionStore));

        expect((await runtime.admitIncomingMessage(message, PENDING_SOURCE)).right).toEqual({ kind: 'pending-admission' });
        await expect.poll(async () => {
            await dependencies.queueEngine.executeOnce();
            return delivered.length;
        }).toBe(1);
        return delivered.map((delivery) => delivery.id.msgId);
    };
    const thrownFor: string[] = [];

    const withThrowingSink = await deliveredWith((event) => {
        // The ingress states `pending`; the sink fails only on the replay's own verdict, so the guard pinned is the replay's.
        if (event.kind !== 'admission-outcome' || event.outcome === 'pending') {
            return;
        }
        thrownFor.push(event.outcome);
        throw new Error('sink failed');
    });

    expect(thrownFor).toHaveLength(1);
    expect(withThrowingSink).toEqual(await deliveredWith(undefined));
});

it('a replay that conflicts again states pending again', async () => {
    const { fixture, message } = await startReplayThatConflictsAgain({});

    await expect.poll(async () => {
        await fixture.queueEngine.executeOnce();
        return fixture.delivered;
    }).toEqual(['dispatched']);

    expect(toAdmissionOutcomes(fixture.diagnostics, message).map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
        { outcome: 'pending', reason: 'pending-admission' },
        { outcome: 'pending', reason: 'pending-admission' },
        { outcome: 'committed', reason: 'admitted' }
    ]);
});

it('a replay on the volatile lane states the runtime\'s worker id and the retained arrival\'s carrier', async () => {
    const volatileStores = createVolatileALInboundRuntimeStores({}, undefined);
    const { runtime, diagnostics, delivered, queueEngine } = createInboundTestRuntime({
        carrier: 'rtc',
        stores: createDefaultInMemoryALInboundRuntimeStores(),
        volatileStores,
        effectWorkerId: 'volatile-replay-worker'
    });
    await runtime.ready();
    // No declared durability keeps the message in the memory pair, whose lane works as `…/volatile`.
    const message = createInboundTestMessage({ msgId: 'volatile-replay' });
    // Every attempt's write of the arrival is lost, so the volatile lane retains it and replays it.
    restoreInboundWritesOnRetention(volatileStores, setNextInboundAdmissionParked(volatileStores.admissionStore));

    expect((await runtime.admitIncomingMessage(message, PENDING_SOURCE)).right).toEqual({ kind: 'pending-admission' });
    await expect.poll(async () => {
        await queueEngine.executeOnce();
        return delivered;
    }).toEqual(['dispatched']);

    expect(toAdmissionOutcomeOrigins(diagnostics, message)).toEqual([
        { workerId: 'volatile-replay-worker', carrier: 'rtc', outcome: 'pending' },
        { workerId: 'volatile-replay-worker', carrier: 'rtc', outcome: 'committed' }
    ]);
});

it('a replay its stored WS client scope no longer authorizes states unauthorized', async () => {
    const { runtime, stores, diagnostics, delivered, queueEngine } = createInboundTestRuntime({
        carrier: 'ws',
        stores: createDefaultInMemoryALInboundRuntimeStores(),
        effectWorkerId: 'stored-scope-worker',
        // The current authority answers for the sender under a scope other than the room the message names.
        readPendingAdmissionAuthority: async () => ({
            kind: 'authorized',
            source: { ...INBOUND_TEST_SOURCE, authenticatedScope: { applicationId: 'app-2', workspaceId: 'workspace-2' } }
        })
    });
    await runtime.ready();
    const unscoped = createInboundTestMessage({ msgId: 'stored-scope' });
    const message: ALMessage = {
        ...unscoped,
        targets: { mode: 'unicast', toPeerId: 'receiver', groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room' } }
    };
    // Every attempt's write of the arrival is lost, so the stored scope is judged by its replay.
    restoreInboundWritesOnRetention(stores, setNextInboundAdmissionParked(stores.admissionStore));

    expect((await runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right).toEqual({ kind: 'pending-admission' });
    await expect.poll(async () => {
        await queueEngine.executeOnce();
        return toAdmissionOutcomes(diagnostics, message).length;
    }).toBe(2);

    expect(toAdmissionOutcomes(diagnostics, message).map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
        { outcome: 'pending', reason: 'pending-admission' },
        { outcome: 'unauthorized', reason: 'unauthorized' }
    ]);
    expect(delivered).toEqual([]);
});

it('a replay that shutdown cuts short before its verdict states nothing', async () => {
    const { fixture, message } = await runReplayThatShutdownCutsShort(undefined);

    expect(toAdmissionOutcomes(fixture.diagnostics, message).map(({ outcome }) => outcome)).toEqual(['pending']);
    expect(fixture.delivered).toEqual([]);
});

type ReplayArrangementInput = Pick<CreateInboundTestRuntimeInput, 'readPendingAdmissionAuthority' | 'onReplayAdmitted'>;

interface StartedReplay {
    readonly fixture: InboundTestRuntime;
    readonly message: ALMessage;
}

/** A conflicted admission retained, whose replay's own write meets the fence again. */
async function startReplayThatConflictsAgain(input: ReplayArrangementInput): Promise<StartedReplay> {
    const fixture = createInboundTestRuntime({
        carrier: 'rtc',
        stores: createDefaultInMemoryALInboundRuntimeStores(),
        effectWorkerId: 'replay-conflicts-worker',
        ...input
    });
    await fixture.runtime.ready();
    const message = createInboundTestMessage({ msgId: 'replay-conflicts' });
    // Every attempt's write of the arrival is lost, so it is retained however often its owner looks again.
    const restoreWrites = setNextInboundAdmissionParked(fixture.stores.admissionStore);
    restoreInboundWritesOnRetention(fixture.stores, () => {
        restoreWrites();
        // The replay's own write meets the fence again, as when another arrival moved the surface once more.
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    });

    expect((await fixture.runtime.admitIncomingMessage(message, PENDING_SOURCE)).right).toEqual({ kind: 'pending-admission' });
    return { fixture, message };
}

/** A conflicted admission retained, whose replay the runtime's disposal cuts short while it asks its authority. */
async function runReplayThatShutdownCutsShort(
    onReplayAdmitted: ALInboundMessageRuntime.Dependencies['onReplayAdmitted']
): Promise<StartedReplay> {
    const authorityAsked = Promise.withResolvers<void>();
    const authorityAnswer = Promise.withResolvers<void>();
    const fixture = createInboundTestRuntime({
        carrier: 'rtc',
        stores: createDefaultInMemoryALInboundRuntimeStores(),
        effectWorkerId: 'shutdown-replay-worker',
        readPendingAdmissionAuthority: async (_msg, source) => {
            authorityAsked.resolve();
            await authorityAnswer.promise;
            return { kind: 'authorized', source };
        },
        onReplayAdmitted
    });
    await fixture.runtime.ready();
    const message = createInboundTestMessage({ msgId: 'shutdown-replay' });
    // Every attempt's write of the arrival is lost, so it is retained for the replay the shutdown cuts short.
    restoreInboundWritesOnRetention(fixture.stores, setNextInboundAdmissionParked(fixture.stores.admissionStore));

    expect((await fixture.runtime.admitIncomingMessage(message, PENDING_SOURCE)).right).toEqual({ kind: 'pending-admission' });
    await authorityAsked.promise;
    const disposed = fixture.runtime.dispose();
    authorityAnswer.resolve();
    await disposed;
    return { fixture, message };
}

/** Who stated each `admission-outcome` about one message, and over which carrier. */
function toAdmissionOutcomeOrigins(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[], message: ALMessage) {
    return diagnostics.flatMap((event) =>
        event.kind === 'admission-outcome' && event.msgId === message.id.msgId
            ? [{ workerId: event.workerId, carrier: event.carrier, outcome: event.outcome }]
            : []
    );
}

/** The `admission-outcome` events stated about one message, in the order they were stated. */
function toAdmissionOutcomes(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[], message: ALMessage) {
    return diagnostics.flatMap((event) =>
        event.kind === 'admission-outcome' && event.msgId === message.id.msgId
            ? [{ workerId: event.workerId, outcome: event.outcome, reason: event.reason, traceId: event.traceId, corrId: event.corrId }]
            : []
    );
}

/** The resources of the NACK controls the runtime sent, in send order. */
function toSentNackResources(controls: readonly ALMessage[]): readonly { readonly msgId: string; readonly reason: string; }[] {
    return controls
        .filter((control) => control.payload.typeId === AL_CONTROL_NACK_TYPE_ID)
        .map((control) => JSON.parse(control.payload.resource));
}

interface RecordedHandOver extends ALInboundMessageRuntime.ReplayedAdmission {
    /** How many deliveries had run when the hand-over was made. */
    readonly deliveredBefore: number;
}

/** An owner that records each hand-over it receives, with the deliveries that had run by then. */
function recordHandOvers(delivered: readonly ALMessage[]) {
    const handedOver: RecordedHandOver[] = [];
    const onReplayAdmitted = async (admitted: ALInboundMessageRuntime.ReplayedAdmission) => {
        handedOver.push({ ...admitted, deliveredBefore: delivered.length });
    };
    return { handedOver, onReplayAdmitted };
}

async function runUntilRetainedStatus(queueEngine: InboxOutboxEngine, stores: ALInboundRuntimeStores, status: EntityStatus | undefined): Promise<void> {
    await expect.poll(async () => {
        await queueEngine.executeOnce();
        return await readRetainedAdmissionStatus(stores);
    }).toBe(status);
}

/** The retained admission row under whichever key the queue gave it, with the status it now holds. */
async function readRetainedAdmissionStatus(stores: ALInboundRuntimeStores): Promise<EntityStatus | undefined> {
    for (const key of await stores.workQueue.getAllKeys()) {
        const entry = await stores.workQueue.getItem(key);
        if (entry === undefined) {
            continue;
        }
        const work = decodeALInboundWorkEntry(entry, stores.admissionStore.namespace);
        if (work.payload.kind === 'admit-message') {
            return entry.status;
        }
    }
    return undefined;
}

interface RetainedConflictedAdmission {
    readonly message: ALMessage;
    readonly work: ALPersistedInboundEffect;
}

async function retainConflictedAdmission(stores: ALInboundRuntimeStores): Promise<RetainedConflictedAdmission> {
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(stores, delivered, controls);
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        planIncomingMessage: (msg, source, observations) => {
            const plan = dependencies.planIncomingMessage(msg, source, observations);
            return { ...plan, effective: { ...plan.effective, expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } } };
        },
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    const commit = stores.admissionStore.commitBundle.bind(stores.admissionStore);
    vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        // A genuine prior observation changes at the existing conditional write boundary.
        expect(await commit({ ...bundle, mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'), durableEffects: [] })).toBe(
            'committed'
        );
        const result = await commit(bundle);
        expect(result).toBe('conflict');
        return result;
    });
    // Every later attempt's write is lost too, so the admission is retained however often its owner looks again.
    const restoreWrites = loseInboundWritesFromNowOn(stores.admissionStore);
    const enqueue = stores.workQueue.enqueueIfAbsent.bind(stores.workQueue);
    let disposing: Promise<void> | undefined;
    const retained = vi.spyOn(stores.workQueue, 'enqueueIfAbsent').mockImplementationOnce(async (entry) => {
        const stored = await enqueue(entry);
        disposing = runtime.dispose(); // Simulate disposal after durable retention, before the first claim.
        return stored;
    });
    const message = newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'sender',
        route: { topicId: 'chat', resourceId: 'message', contextId: 'room' },
        toPeerId: 'receiver',
        typeId: 'chat',
        resource: {},
        options: {
            ttlMs: 60_000,
            qos: { ack: { algo: 'hop' } }
        }
    });
    const result = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: 'sender' });
    await disposing;
    expect(result.right).toEqual({ kind: 'pending-admission' });
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
    const keys = await stores.workQueue.getAllKeys();
    expect(keys).toHaveLength(1);
    const entry = await stores.workQueue.getItem(keys[0]);
    expect(entry).toBeDefined();
    restoreWrites();
    retained.mockRestore();
    return { message, work: decodeALInboundWorkEntry(entry!, stores.admissionStore.namespace) };
}

function runtimeDependencies(stores: ALInboundRuntimeStores, delivered: ALMessage[], controls: ALMessage[]): ALInboundMessageRuntime.Dependencies {
    return {
        readUpstreamPeerId: () => undefined,
        readGapNackRelayHops: () => AL_GAP_NACK_RELAY_HOP_LIMIT,
        isRoutedPeerReady: () => false,
        isLayoutChildPeer: () => false,
        receiptProofs: { kind: 'carrier-authenticated' },
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            stores,
            queueEngine: new InboxOutboxEngine(),
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox', Temporal.Now.instant())
        }),
        carrier: 'rtc',
        orderingObserver: 'addressed',
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, { ...observations, selfPeerId: 'receiver', fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId }),
        dispatchInboxEntry: async (entry: ResourceEntry) => {
            delivered.push(decodePersistedALMessage(entry.resource));
        },
        sendControlMessages: async (messages) => {
            controls.push(...messages);
        },
        diagnostics: undefined
    };
}
