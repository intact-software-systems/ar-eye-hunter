import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { toALInboundWorkKey, toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/compute-al-inbound-admission.ts';
import { createDefaultALInboundMessageRuntime } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { EntityStatus, NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres inbound ordered work recovery', () => {
    postgresIt('retains ordered completion across runtime restart and work-row cleanup', async () => {
        const [firstStores, secondStores] = await createStores();
        const firstStore = firstStores.admissionStore;
        const secondStore = secondStores.admissionStore;
        const received: string[] = [];
        const first = createRuntime(firstStores, received);
        const secondMessage = createMessage('second', 2);
        const trackKey = toALOrderingTrackKey(secondMessage)!;
        await first.admitIncomingMessage(secondMessage, { kind: 'ws-client', peerId: 'sender' });

        // A gap retains no deliverable work, so the settled queue is read beside the fence that holds it.
        await waitForSettledInboundWork(firstStores);
        await expect.poll(() => firstStore.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() }))
            .toBeDefined();
        expect(received).toEqual([]);
        first.dispose();

        const second = createRuntime(secondStores, received);
        const firstMessage = createMessage('first', 1);
        await second.admitIncomingMessage(firstMessage, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(() => received).toEqual(['first', 'second']);
        await expect.poll(() => firstStore.readOrderedDelivery(trackKey, 3))
            .toEqual({ completedThrough: 2, predecessor: undefined });
        second.dispose();

        const completed = await firstStores.workQueue.readWorkPage({
            typeId: toALInboundWorkType(firstStore.namespace),
            status: EntityStatus.COMPLETED,
            maxToRead: 16,
            cursor: null
        });
        expect(completed.entries.length).toBeGreaterThan(0);
        for (const entry of completed.entries) {
            await firstStores.workQueue.removeItem(entry.key);
        }
        const restarted = createRuntime(firstStores, received);
        await restarted.admitIncomingMessage(createMessage('third', 3), { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(() => received).toEqual(['first', 'second', 'third']);
        await expect.poll(() => secondStore.readOrderedDelivery(trackKey, 4))
            .toEqual({ completedThrough: 3, predecessor: undefined });
        await restarted.admitIncomingMessage(secondMessage, { kind: 'ws-client', peerId: 'sender' });

        // The redelivered duplicate must not dispatch again: settle every retained row before reading.
        await waitForSettledInboundWork(firstStores);
        expect(received).toEqual(['first', 'second', 'third']);
    });

    postgresIt('rejects stale delivery progress after another connection completes the predecessor', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        const message = createMessage('first', 1);
        await admit(first, message);
        const trackKey = toALOrderingTrackKey(message)!;
        const observed = await second.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() });
        if (!observed) {
            throw new Error('Expected the admitted ordering fence');
        }
        const completion = {
            senderId: 'sender',
            observations: observed.observations,
            mutations: [{
                kind: 'set-delivery-progress' as const,
                trackKey,
                value: {
                    completedThrough: 1,
                    expireAtTimestamp: observed.observations.deliveryProgress!.value!.expireAtTimestamp
                }
            }, { kind: 'delete-buffered' as const, trackKey, seq: 1 }]
        };
        expect(await first.commitMutations(completion)).toBe('committed');
        expect(await second.commitMutations(completion)).toBe('conflict');
        expect(await second.readOrderedDelivery(trackKey, 2))
            .toEqual({ completedThrough: 1, predecessor: undefined });
    });

    postgresIt('preserves an extended deadline when another connection completes from a stale read', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        const message = createMessage('first', 1);
        await admit(first, message);
        const trackKey = toALOrderingTrackKey(message)!;
        const observed = (await second.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() }))!;
        const original = observed.observations.deliveryProgress!.value!;
        const deadline = original.expireAtTimestamp + 60_000;
        await admit(first, { ...createMessage('second', 2), constraints: { expiresAtMs: deadline } });

        const refreshed = (await second.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() }))!;
        expect(refreshed.observations).toEqual({
            ...observed.observations,
            deliveryProgress: { trackKey, value: { completedThrough: 0, expireAtTimestamp: deadline } }
        });
        expect(
            await second.commitMutations({
                senderId: 'sender',
                observations: observed.observations,
                mutations: [
                    { kind: 'set-delivery-progress', trackKey, value: { ...original, completedThrough: 1 } },
                    { kind: 'delete-buffered', trackKey, seq: 1 }
                ]
            })
        ).toBe('conflict');
        expect(await first.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() })).toBeDefined();

        expect(
            await second.commitMutations({
                senderId: 'sender',
                observations: refreshed.observations,
                mutations: [
                    { kind: 'set-delivery-progress', trackKey, value: { completedThrough: 1, expireAtTimestamp: deadline } },
                    { kind: 'delete-buffered', trackKey, seq: 1 }
                ]
            })
        ).toBe('committed');
        const remaining = (await first.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() }))!;
        expect(remaining.observations.deliveryProgress?.value).toEqual({
            completedThrough: 1,
            expireAtTimestamp: deadline
        });
    });

    postgresIt('terminalizes a malformed predecessor, requests resynchronization and delivers unrelated work', async () => {
        const [firstStores, secondStores] = await createStores();
        const first = firstStores.admissionStore;
        const second = secondStores.admissionStore;
        await admit(first, createMessage('malformed', 1));
        const page = await firstStores.workQueue.readWorkPage({
            typeId: toALInboundWorkType(first.namespace),
            status: EntityStatus.NEW,
            maxToRead: 16,
            cursor: null
        });
        const predecessor = page.entries[0];
        if (!predecessor) {
            throw new Error('Expected durable work for the first message');
        }
        expect(await firstStores.workQueue.replaceIfObserved(predecessor, { ...predecessor, resource: '{invalid-json' }))
            .not.toBeNull();
        const received: string[] = [];
        const controls: ALMessage[] = [];
        const runtime = createRuntime(secondStores, received, controls);
        await runtime.ready();
        expect(await firstStores.workQueue.getItem(predecessor.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1, nextTs: undefined }
        });
        const blocked = createMessage('blocked', 2);
        await runtime.admitIncomingMessage(blocked, { kind: 'ws-client', peerId: 'sender' });
        await runtime.admitIncomingMessage(createMessage('independent'), { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(() => received).toEqual(['independent']);
        await expect.poll(() =>
            controls.flatMap((message) => {
                const parsed = parseALControlMessage(message);
                return parsed?.type === 'nack' && parsed.payload.reason === 'resync-required' ? [parsed.payload.msgId] : [];
            })
        ).toContain(blocked.id.msgId);
    });
});

/**
 * Delivery no longer runs inside admission: wait until every retained row reaches a terminal status.
 * Scoped to this namespace because a Postgres queue reports keys for the whole shared table.
 */
async function waitForSettledInboundWork(stores: ALInboundRuntimeStores): Promise<void> {
    const typeId = toALInboundWorkType(stores.admissionStore.namespace);
    await expect.poll(async () => {
        for (const status of NOT_COMPLETED_RETRYABLE_STATUSES) {
            const page = await stores.workQueue.readWorkPage({ typeId, status, maxToRead: 1, cursor: null });
            if (page.entries.length > 0) {
                return false;
            }
        }
        return true;
    }).toBe(true);
}

async function createStores(): Promise<readonly [ALInboundRuntimeStores, ALInboundRuntimeStores]> {
    const namespace = `inbound-work-recovery-${crypto.randomUUID()}`;
    const queueContext = toALInboundWorkKey(namespace, '').contextId;
    const first = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await first`delete from resource_inbox where fk_ext_bank_id = ${queueContext}`;
            await first`delete from runtime_state_store where store_namespace = ${namespace}`;
        }
        finally {
            await first.end();
        }
    });
    const second = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => second.end());
    const configuration = {
        namespace,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    };
    const firstBackend = new PSqlAdmissionWorkBackend(first, namespace);
    const secondBackend = new PSqlAdmissionWorkBackend(second, namespace);
    return [
        {
            admissionStore: createALInboundAdmissionStore({ ...configuration, backend: firstBackend }),
            workQueue: firstBackend.workQueue
        },
        {
            admissionStore: createALInboundAdmissionStore({ ...configuration, backend: secondBackend }),
            workQueue: secondBackend.workQueue
        }
    ];
}

function createRuntime(stores: ALInboundRuntimeStores, received: string[], controls: ALMessage[] = []) {
    const runtime = createDefaultALInboundMessageRuntime({
        selfPeerId: 'receiver',
        stores,

        planIncomingMessage: (message, source, observations) =>
            planALMessageHandling(message, {
                selfPeerId: 'receiver',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                ...observations
            }),
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'),
        dispatchInboxEntry: async (entry) => {
            received.push(decodePersistedALMessage(entry.resource).route.resourceId);
        },
        sendControlMessage: async (message) => {
            controls.push(message);
        }
    });
    onTestFinished(() => runtime.dispose());
    return runtime;
}

function createMessage(resourceId: string, sequence?: number): ALMessage {
    const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId, contextId: 'receiver' }, 'receiver', 'chat', {}, {
        ttlMs: 30_000,
        qos: { delivery: { algo: 'best-effort' }, ack: { algo: 'none' }, durability: { algo: 'volatile' } }
    });
    return { ...message, ordering: sequence === undefined ? undefined : { orderingKey: 'stream', epoch: 0, seq: sequence } };
}

async function admit(store: ALInboundAdmissionStore, message: ALMessage): Promise<void> {
    const nowMs = Date.now();
    const source = { kind: 'ws-client' as const, peerId: 'sender' };
    const prePlan = planALMessageHandling(message, { selfPeerId: 'receiver', fromPeerId: 'sender', nowMs });
    const read = await store.readIncomingMessage({ msg: message, source, nowMs, prePlan });
    const plan = planALMessageHandling(message, {
        selfPeerId: 'receiver',
        fromPeerId: 'sender',
        ...computeALInboundPlanningObservations(read)
    });
    const facts = readALInboundEffectFacts(nowMs, {
        selfPeerId: 'receiver',
        newControlId: crypto.randomUUID.bind(crypto),
        createInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
    });
    expect(await store.commitBundle(computeALInboundAdmission({ read, plan, facts, canForward: false }))).toBe('committed');
}
