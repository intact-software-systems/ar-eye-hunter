import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import '../../setup-browser-indexeddb.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createDefaultIndexedDbALInboundRuntimeStores, createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

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
        const fixture = await retainConflictedAdmission(stores.admissionStore);
        expect(fixture.work.payload).toMatchObject({ kind: 'admit-message', source: { kind: 'rtc-peer', peerId: 'sender' } });
        expect(fixture.work.expireAtTimestamp).toBe(Date.now() + 1_000);
        expect(fixture.work.entry.status).toBe(EntityStatus.NEW);
        const restartedStore = backend === 'memory' ? stores.admissionStore : createDefaultIndexedDbALInboundRuntimeStores(options).admissionStore;
        const delivered: ALMessage[] = [];
        const controls: ALMessage[] = [];
        const dependencies = runtimeDependencies(restartedStore, delivered, controls);
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
        const completed = await restartedStore.workQueue.getItem(fixture.work.entry.key);
        expect(completed?.status).toBe(EntityStatus.COMPLETED);
        // Recovery followed by a normal duplicate cannot dispatch another copy.
        const duplicate = await restarted.admitIncomingMessage(fixture.message, { kind: 'rtc-peer', peerId: 'sender' });
        expect(duplicate.right?.kind).toBe('duplicate');
        expect(delivered).toHaveLength(1);
    }
);

it.each(['authority', 'deadline'] as const)('checks current %s before admitting retained pending work', async (boundary) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const store = createDefaultInMemoryALInboundRuntimeStores().admissionStore;
    const fixture = await retainConflictedAdmission(store);
    if (boundary === 'deadline') {
        vi.setSystemTime(fixture.work.expireAtTimestamp);
    }
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(store, delivered, controls);
    const planner = vi.fn<ALInboundMessageRuntime.Dependencies['planIncomingMessage']>((msg, source, observations) => {
        const current = dependencies.planIncomingMessage(msg, source, observations);
        return boundary === 'authority' ? { ...current, dropReason: 'Room authorization was revoked' } : current;
    });
    const restarted = new ALInboundMessageRuntime({ ...dependencies, planIncomingMessage: planner });
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
    const store = createDefaultInMemoryALInboundRuntimeStores().admissionStore;
    const fixture = await retainConflictedAdmission(store);
    if (fixture.work.payload.kind !== 'admit-message') {
        throw new Error('Expected pending admission');
    }
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(store, delivered, controls);
    const restarted = new ALInboundMessageRuntime({
        ...dependencies,
        readPendingAdmissionAuthority: async () => ({ kind: 'rejected' })
    });
    onTestFinished(() => restarted.dispose());
    await restarted.ready();
    const terminal = await store.workQueue.getItem(fixture.work.entry.key);
    expect(terminal?.status).toBe(EntityStatus.COMPLETED);
    const nowMs = Date.now();
    const prePlan = dependencies.planIncomingMessage(fixture.message, fixture.work.payload.source, { nowMs });
    const admissionRead = await store.readIncomingMessage({ msg: fixture.message, source: fixture.work.payload.source, nowMs, prePlan });
    expect(admissionRead.dedupExpiresAt).toBeUndefined();

    const admission = new ALInboundMessageAdmission(dependencies);
    onTestFinished(() => admission.dispose());
    expect(await admission.retainPending(fixture.work.payload)).toMatchObject({ kind: 'not-admitted' });
    expect(await store.workQueue.getItem(fixture.work.entry.key)).toEqual(terminal);
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
});

it.each(['payload', 'source', 'scope', 'deadline'] as const)('refuses a conflicting pending %s observation at the existing QueueBox slot', async (field) => {
    const store = createDefaultIndexedDbALInboundRuntimeStores({ dbName: `pending-conflict-${crypto.randomUUID()}`, namespace: 'full-scope' }).admissionStore;
    const fixture = await retainConflictedAdmission(store);
    if (fixture.work.payload.kind !== 'admit-message') {
        throw new Error('Expected pending admission');
    }
    const before = await store.workQueue.getItem(fixture.work.entry.key);
    const pending = fixture.work.payload;
    const admission = new ALInboundMessageAdmission(runtimeDependencies(store, [], []));
    if (field === 'scope') {
        const resource = JSON.stringify({ ...JSON.parse(fixture.work.entry.resource), namespace: 'other-full-scope' });
        await store.workQueue.enqueue({ ...fixture.work.entry, resource });
        await expect(admission.retainPending(pending)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        expect((await store.workQueue.getItem(fixture.work.entry.key))?.resource).toBe(resource);
        return;
    }
    const candidate = field === 'payload'
        ? { ...pending, msg: { ...pending.msg, payload: { ...pending.msg.payload, resource: '{"changed":true}' } } }
        : field === 'source'
        ? { ...pending, source: { kind: 'trusted-server' as const } }
        : { ...pending, msg: { ...pending.msg, constraints: { ...pending.msg.constraints, expiresAtMs: fixture.work.expireAtTimestamp + 1 } } };
    await expect(admission.retainPending(candidate)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    expect(await store.workQueue.getItem(fixture.work.entry.key)).toEqual(before);
});

it('never retains malformed, forged, unknown-control or planner-rejected ingress', async () => {
    const store = createDefaultInMemoryALInboundRuntimeStores().admissionStore;
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(store, delivered, controls);
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        planIncomingMessage: (msg, source, observations) => ({
            ...dependencies.planIncomingMessage(msg, source, observations),
            dropReason: 'Room authorization was revoked'
        })
    });
    onTestFinished(() => runtime.dispose());
    const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', {});
    const untrackedAck = newALAckControlMessage({ v: 2, senderId: 'sender', msgId: 'unknown-control', ts: Date.now() }, {
        ackedMsgId: 'unknown',
        fromPeerId: 'sender',
        toPeerId: 'receiver',
        status: 'delivered',
        observedAtEpochMs: Date.now()
    });
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
    const read = await store.readIncomingMessage({
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
    expect(await store.workQueue.getAllKeys()).toEqual([]);
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
});

async function retainConflictedAdmission(store: ALInboundAdmissionStore) {
    const delivered: ALMessage[] = [];
    const controls: ALMessage[] = [];
    const dependencies = runtimeDependencies(store, delivered, controls);
    const runtime = new ALInboundMessageRuntime({
        ...dependencies,
        planIncomingMessage: (msg, source, observations) => {
            const plan = dependencies.planIncomingMessage(msg, source, observations);
            return { ...plan, effective: { ...plan.effective, expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 1_000 } } } };
        }
    });
    onTestFinished(() => runtime.dispose());
    const commit = store.commitBundle.bind(store);
    const conflict = vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle) => {
        // A genuine prior observation changes at the existing conditional write boundary.
        expect(await commit({ ...bundle, mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'), durableEffects: [] })).toBe(
            'committed'
        );
        const result = await commit(bundle);
        expect(result).toBe('conflict');
        return result;
    });
    const enqueue = store.workQueue.enqueueIfAbsent.bind(store.workQueue);
    const retained = vi.spyOn(store.workQueue, 'enqueueIfAbsent').mockImplementationOnce(async (entry) => {
        const stored = await enqueue(entry);
        runtime.dispose(); // Simulate disposal after durable retention, before the first claim.
        return stored;
    });
    const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', {}, {
        ttlMs: 60_000,
        qos: { ack: { algo: 'hop' } }
    });
    const result = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: 'sender' });
    expect(result.right).toEqual({ kind: 'pending-admission' });
    expect(delivered).toEqual([]);
    expect(controls).toEqual([]);
    expect(conflict).toHaveBeenCalledTimes(1);
    const entry = await store.workQueue.getItem(retained.mock.calls[0][0].key);
    expect(entry).toBeDefined();
    conflict.mockRestore();
    retained.mockRestore();
    return { message, work: decodeALInboundWorkEntry(entry!, store.namespace) };
}

function runtimeDependencies(store: ALInboundAdmissionStore, delivered: ALMessage[], controls: ALMessage[]): ALInboundMessageRuntime.Dependencies {
    return {
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            stores: { admissionStore: store, workQueue: store.workQueue },
            queueEngine: new InboxOutboxEngine(),
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
        }),
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, { ...observations, selfPeerId: 'receiver', fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId }),
        readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
        dispatchInboxEntry: async (entry: ResourceEntry) => {
            delivered.push(decodePersistedALMessage(entry.resource));
        },
        sendControlMessage: async (msg) => {
            controls.push(msg);
        }
    };
}
