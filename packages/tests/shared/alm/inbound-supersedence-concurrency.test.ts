import '../../setup-browser-indexeddb.ts';

import { describe, expect, it } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundPlanningObservations
} from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { computeALInboundAdmission, computeALInboundBufferedRelease } from '@shared/alm/inbound/compute-al-inbound-admission.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import { createPSqlAdmissionTestStorage } from '../../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';

describe.each(['memory', 'indexeddb', 'pglite'] as const)('inbound shared supersedence in %s', (storage) => {
    it('admits independent messages from the same sender using their original reads', async () => {
        const store = await createStore(storage);
        const first = await readDecision(store, createMessage('same-sender', 1, 'first-topic'));
        const second = await readDecision(store, createMessage('same-sender', 2, 'second-topic'));
        const original = JSON.stringify(second.bundle);

        expect(await store.commitBundle(first.bundle)).toBe('committed');
        expect(await store.commitBundle(second.bundle)).toBe('committed');

        expect(JSON.stringify(second.bundle)).toBe(original);
        expect(await completeEffects(store)).toEqual(expect.arrayContaining([first.read.msg.id.msgId, second.read.msg.id.msgId]));
    });

    it('still conflicts when two decisions admit the same message', async () => {
        const store = await createStore(storage);
        const message = createMessage('same-sender', 1);
        const first = await readDecision(store, message);
        const duplicate = await readDecision(store, message);

        expect(await store.commitBundle(first.bundle)).toBe('committed');
        expect(await store.commitBundle(duplicate.bundle)).toBe('conflict');
        expect((await readDecision(store, message)).plan.dropReason).toContain('Duplicate message');
        expect(await completeEffects(store)).toEqual([message.id.msgId]);
    });

    it('conflicts on a shared semantic dedup key across otherwise independent senders', async () => {
        const store = await createStore(storage);
        const firstMessage = createMessage('sender-a', 1, 'first-topic');
        const secondMessage = createMessage('sender-b', 2, 'second-topic');
        const dedup = { algo: 'semantic-key' as const, opts: { semanticKey: 'same-command' } };
        const first = await readDecision(store, { ...firstMessage, qos: { ...firstMessage.qos, dedup } });
        const second = await readDecision(store, { ...secondMessage, qos: { ...secondMessage.qos, dedup } });

        expect(await store.commitBundle(first.bundle)).toBe('committed');
        expect(await store.commitBundle(second.bundle)).toBe('conflict');

        const retry = await readDecision(store, second.read.msg);
        expect(retry.plan.dropReason).toContain('Duplicate message');
        expect(retry.read.observations.messageOwner).toBeUndefined();
        expect(await completeEffects(store)).toEqual([firstMessage.id.msgId]);
    });

    it('recomputes a shared ordering track after a different message advances it', async () => {
        const store = await createStore(storage);
        const first = { ...createMessage('same-sender', 1, 'first-topic'), ordering: { orderingKey: 'ordered', seq: 1 } };
        const second = { ...createMessage('same-sender', 2, 'second-topic'), ordering: { orderingKey: 'ordered', seq: 2 } };
        const firstDecision = await readDecision(store, first);
        const secondDecision = await readDecision(store, second);

        expect(await store.commitBundle(secondDecision.bundle)).toBe('committed');
        expect(await store.commitBundle(firstDecision.bundle)).toBe('conflict');
        const retry = await readDecision(store, first);
        expect(retry.plan.orderingRuntime.releasableSeqs).toEqual([2]);
        expect(await store.commitBundle(retry.bundle)).toBe('committed');
    });

    it.each([false, true])('rejects a stale sender decision without recording its delivery or deduplication (populated: %s)', async (populated) => {
        const store = await createStore(storage);
        if (populated) {
            const seed = await readDecision(store, createMessage('seed', 0));
            expect(await store.commitBundle(seed.bundle)).toBe('committed');
            await completeEffects(store);
        }
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const oldDecision = await readDecision(store, older);
        const newDecision = await readDecision(store, newer);
        const originalCandidate = JSON.stringify(oldDecision.bundle);
        expect(oldDecision.plan.dropReason).toBeUndefined();
        expect(newDecision.plan.dropReason).toBeUndefined();

        expect(await store.commitBundle(newDecision.bundle)).toBe('committed');
        expect(await store.commitBundle(oldDecision.bundle)).toBe('conflict');

        expect(JSON.stringify(oldDecision.bundle)).toBe(originalCandidate);
        const refreshed = await readDecision(store, older);
        expect(refreshed.read.observations.messageOwner).toBeUndefined();
        expect(refreshed.read.dedupExpiresAt).toBeUndefined();
        expect(refreshed.plan.supersedence.status).toBe('superseded');
        expect(refreshed.read.supersedence.latest?.latestMsgId).toBe(newer.id.msgId);
        expect(await completeEffects(store)).toEqual([newer.id.msgId]);
    });

    it('allows unrelated work and recomputes a newer message after conflict', async () => {
        const store = await createStore(storage);
        const older = createMessage('sender-a', 1);
        const newer = createMessage('sender-b', 2);
        const unrelated = createMessage('sender-c', 3, 'other-topic');
        const oldDecision = await readDecision(store, older);
        const newDecision = await readDecision(store, newer);
        const otherDecision = await readDecision(store, unrelated);

        expect(await store.commitBundle(oldDecision.bundle)).toBe('committed');
        expect(await store.commitBundle(otherDecision.bundle)).toBe('committed');
        expect(await store.commitBundle(newDecision.bundle)).toBe('conflict');
        const retry = await readDecision(store, newer);
        expect(retry.plan.dropReason).toBeUndefined();
        expect(await store.commitBundle(retry.bundle)).toBe('committed');

        const refreshed = await readDecision(store, older);
        expect(refreshed.read.supersedence.latest?.latestMsgId).toBe(newer.id.msgId);
        expect(refreshed.read.supersedence.replacement?.byMsgId).toBe(newer.id.msgId);
        const otherRead = await readDecision(store, unrelated);
        expect(otherRead.read.supersedence.latest?.latestMsgId).toBe(unrelated.id.msgId);
    });

    it('rejects a buffered-release decision when another sender changes its original observation', async () => {
        const store = await createStore(storage);
        const older = { ...createMessage('sender-a', 1), ordering: { orderingKey: 'ordered-topic', seq: 1 } };
        const newer = { ...createMessage('sender-b', 2), ordering: { orderingKey: 'ordered-topic', seq: 1 } };
        const admitted = await readDecision(store, older);
        expect(await store.commitBundle(admitted.bundle)).toBe('committed');
        expect(await completeEffects(store)).toEqual([older.id.msgId]);
        const trackKey = toALOrderingTrackKey(older);
        if (trackKey === undefined) {
            throw new Error('Ordered message requires a track key');
        }
        const read = await store.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() });
        if (read === undefined) {
            throw new Error('Expected the retained ordered delivery');
        }
        const plan = planALMessageHandling(older, {
            selfPeerId: 'receiver',
            fromPeerId: older.id.senderId,
            ...computeALInboundBufferedReleasePlanningObservations(read)
        });
        expect(plan.localDelivery.enabled).toBe(true);
        const buffered = computeALInboundBufferedRelease({ read, plan, facts: readEffectFacts(older, read.nowMs) });
        const originalCandidate = JSON.stringify(buffered);
        const newDecision = await readDecision(store, newer);
        expect(newDecision.plan.dropReason).toBeUndefined();
        expect(await store.commitBundle(newDecision.bundle)).toBe('committed');

        expect(await store.commitBundle(buffered)).toBe('conflict');

        expect(JSON.stringify(buffered)).toBe(originalCandidate);
        expect((await store.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() }))?.supersedence.latest?.latestMsgId)
            .toBe(newer.id.msgId);
        expect(await completeEffects(store)).toEqual([newer.id.msgId]);
    });
});

async function createStore(storage: 'memory' | 'indexeddb' | 'pglite') {
    const namespace = `inbound-supersedence-${crypto.randomUUID()}`;
    const backend = storage === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : storage === 'indexeddb'
        ? new IndexedDbAdmissionBackend(namespace, 'admission', Date.now)
        : new PSqlAdmissionWorkBackend((await createPSqlAdmissionTestStorage()).sql, namespace);
    return createALInboundAdmissionStore({
        namespace,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
}

function createMessage(senderId: string, version: number, supersedenceKey = 'shared-topic'): ALMessage {
    const message = newALUnicastMessage(
        senderId,
        { topicId: 'latest-values', resourceId: crypto.randomUUID(), contextId: 'receiver' },
        'receiver',
        'latest-value.v1',
        { version },
        {
            qos: {
                delivery: { algo: 'best-effort' },
                ack: { algo: 'none' },
                durability: { algo: 'volatile' },
                supersedence: { algo: 'latest-wins', opts: { supersedenceKey } }
            }
        }
    );
    const createdTs = Date.now() - 1_000 + version;
    return { ...message, id: { ...message.id, ts: createdTs }, audit: { ...message.audit, createdTs } };
}

async function readDecision(store: ALInboundAdmissionStore, message: ALMessage) {
    const nowMs = Date.now();
    const source = { kind: 'ws-client' as const, peerId: message.id.senderId };
    const context = { selfPeerId: 'receiver', fromPeerId: message.id.senderId, nowMs };
    const prePlan = planALMessageHandling(message, context);
    const read = await store.readIncomingMessage({ msg: message, source, nowMs, prePlan });
    const plan = planALMessageHandling(message, { ...context, ...computeALInboundPlanningObservations(read) });
    return {
        read,
        plan,
        bundle: computeALInboundAdmission({ read, plan, facts: readEffectFacts(message, nowMs), canForward: false })
    };
}

function readEffectFacts(message: ALMessage, nowMs: number) {
    return readALInboundEffectFacts(message, nowMs, {
        selfPeerId: 'receiver',
        createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
}

async function completeEffects(store: ALInboundAdmissionStore): Promise<string[]> {
    const workerId = crypto.randomUUID();
    const effects = await store.claimReadyEffects({ workerId, maxCount: 10, leaseMs: 10_000, nowMs: Date.now() });
    const deliveries: string[] = [];
    for (const effect of effects) {
        if (effect.payload.kind === 'dispatch-local') {
            deliveries.push(decodePersistedALMessage(effect.payload.entry.resource).id.msgId);
        }
        await store.completeEffect(effect.effectId, workerId);
    }
    return deliveries;
}
