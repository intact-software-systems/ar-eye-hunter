import { Temporal } from '@js-temporal/polyfill';
import {
    expect,
    it,
    vi
} from 'vitest';

import {
    configureServerWsQBoxALRuntimeStores,
    createPSqlALInboundRuntimeStores,
    resolveServerWsQBoxALInboundRuntimeStores,
    resolveServerWsQBoxALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALOutboundSentMessageKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { captureALOutboundPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { ALOutboundCapturedPolicyTiming } from '@shared/alm/outbound/admission/al-outbound-captured-policy-timing.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundIdentityEntry,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createPSqlAdmissionTestStorage, type PSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

vi.mock(import('@shared/alm/inbound/al-inbound-admission-store.ts'), async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, createALInboundAdmissionStore: vi.fn(original.createALInboundAdmissionStore) };
});

it('constructs the WS server\'s shared inbound store without an ordering-track cap', () => {
    // Construction issues no statement, so a store that is never read needs no database.
    const sql = {} as PSqlSql;

    createPSqlALInboundRuntimeStores({
        nowMs: Date.now,
        repository: new PSqlRuntimeStateRepository(sql),
        namespace: 'server-ws-qbox:uncapped',
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined
    });

    expect(vi.mocked(createALInboundAdmissionStore)).toHaveBeenCalledWith(
        expect.objectContaining({ maxOrderingTracks: undefined })
    );
});

it('forwards enabled timing through the real server factory only to outbound captured-policy reads', async () => {
    const storage = await createPSqlAdmissionTestStorage();
    const observations: ALOutboundCapturedPolicyTiming.Observation[] = [];
    const readMonotonicMs = vi.fn(() => performance.now());
    const createOwner = vi.fn((namespace: string) =>
        new ALOutboundCapturedPolicyTiming(namespace, {
            readMonotonicMs,
            readEpochMs: Date.now,
            record: (observation) => observations.push(observation)
        })
    );
    const enabledName = 'captured-policy-timed';
    configureServerWsQBoxALRuntimeStores(enabledName, {
        repository: storage.repository,
        capturedPolicyTiming: { createOwner }
    });

    const inbound = resolveServerWsQBoxALInboundRuntimeStores(enabledName);
    await inbound.admissionStore.ready();
    await inbound.workQueue.getItem({ topicId: 'absent', resourceId: 'absent', contextId: 'absent' });
    expect(createOwner).not.toHaveBeenCalled();
    expect(readMonotonicMs).not.toHaveBeenCalled();
    expect(observations).toEqual([]);

    const outbound = resolveServerWsQBoxALOutboundRuntimeStores(enabledName);
    const enabled = await seedCapturedPolicyRead(storage, enabledName, outbound.workQueue);
    await expect(outbound.admissionStore.readCapturedPolicy(enabled.message, enabled.entry))
        .resolves.toMatchObject({ admittedAudience: ['session-a'] });
    expect(createOwner).toHaveBeenCalledTimes(1);
    expect(readMonotonicMs).toHaveBeenCalled();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
        availability: 'available',
        outcome: 'succeeded',
        namespace: `server-ws-qbox:${enabledName}:outbound:admission`
    });
    const enabledClockSamples = readMonotonicMs.mock.calls.length;

    const disabledName = 'captured-policy-untimed';
    configureServerWsQBoxALRuntimeStores(disabledName, { repository: storage.repository });
    const disabledOutbound = resolveServerWsQBoxALOutboundRuntimeStores(disabledName);
    const disabled = await seedCapturedPolicyRead(storage, disabledName, disabledOutbound.workQueue);
    await expect(disabledOutbound.admissionStore.readCapturedPolicy(disabled.message, disabled.entry))
        .resolves.toMatchObject({ admittedAudience: ['session-a'] });
    expect(observations).toHaveLength(1);
    expect(createOwner).toHaveBeenCalledTimes(1);
    expect(readMonotonicMs).toHaveBeenCalledTimes(enabledClockSamples);
});

async function seedCapturedPolicyRead(
    storage: PSqlAdmissionTestStorage,
    name: string,
    workQueue: ReturnType<typeof resolveServerWsQBoxALOutboundRuntimeStores>['workQueue']
) {
    const namespace = `server-ws-qbox:${name}:outbound:admission`;
    const message = newALBroadcastMessage(
        'server',
        newALRoute('room.topic', 'room-1', 'event-1'),
        'room',
        'room.topic',
        { value: 1 },
        { ttlMs: 60_000, groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } }
    );
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
    const reference = toALOutboundMessageReference(namespace, entry, message);
    const creationExpiry = captureALOutboundCreationExpiry(message);
    const stored = {
        msgId: message.id.msgId,
        reference,
        supersedenceKey: undefined,
        unicastPeerId: null,
        orderingTrackKey: null,
        orderingSeq: null,
        policy: captureALOutboundPolicy({
            msg: message,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: [],
            admittedAudience: ['session-a']
        }),
        creationExpiry
    };
    await workQueue.enqueue(toALOutboundIdentityEntry(reference, entry, creationExpiry));
    await storage.repository.upsert(
        namespace,
        toALOutboundSentMessageKey(namespace, message.id.msgId),
        JSON.stringify(stored),
        Date.now() + 120_000
    );
    return { message, entry };
}
