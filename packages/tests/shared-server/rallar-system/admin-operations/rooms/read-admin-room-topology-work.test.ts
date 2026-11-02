import { Temporal } from '@js-temporal/polyfill';
import { expect, it, vi } from 'vitest';

import { ReadAdminRoomTopologyWork } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-work.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createComputedRtcTopologyOutbox } from '../../topology/rtc-topology-test-fixtures.ts';

const work = { ...createComputedRtcTopologyOutbox(), origin: 'commanded' as const, resourceId: 'request-1:rtc-topology-recompute:explicit' };
const request = { roomRef: toCanonicalGroupRef(work.aggregateRef), outboxId: work.resourceId };
const NOW = work.createdAtEpochMs + 1_000;

it('observes the exact retained work without treating queue acceptance as completion', async () => {
    let entry = computeRtcTopologyOutboxInsert(work).entry;
    const findByKey = vi.fn(async () => entry);
    const reader = new ReadAdminRoomTopologyWork({ repository: { findByKey }, nowEpochMs: () => NOW });
    expect(await reader.read(request)).toEqual({
        ...request,
        observedAtEpochMs: NOW,
        status: 'pending',
        attempts: 0,
        settledAtEpochMs: null
    });
    expect(findByKey).toHaveBeenCalledWith(entry.key);
    entry = { ...entry, status: EntityStatus.COMPLETED };
    entry = { ...entry, dequeueAudit: { attempts: 2, endTs: Temporal.Instant.fromEpochMilliseconds(NOW - 10) } };
    const completed = await reader.read(request);
    expect(completed).toMatchObject({ status: 'completed', attempts: 2, settledAtEpochMs: NOW - 10 });
    expect(await reader.read(request)).toEqual(completed);
});

it('reports absent or expired evidence as unknown and preserves infrastructure failures', async () => {
    let stored: ResourceEntry | null = null;
    const findByKey = vi.fn(async () => stored);
    const reader = new ReadAdminRoomTopologyWork({ repository: { findByKey }, nowEpochMs: () => NOW });
    expect(await reader.read(request)).toMatchObject({ status: 'unknown', attempts: null, settledAtEpochMs: null });
    stored = computeRtcTopologyOutboxInsert({ ...work, expireAtEpochMs: NOW }).entry;
    stored.status = EntityStatus.COMPLETED;
    expect(await reader.read(request)).toMatchObject({ status: 'unknown', attempts: null, settledAtEpochMs: null });
    findByKey.mockRejectedValue(new Error('database unavailable'));
    await expect(reader.read(request)).rejects.toThrow('database unavailable');
});

it('reports failed work separately from pending retries and rejects unsupported terminal states', async () => {
    let entry = computeRtcTopologyOutboxInsert(work).entry;
    const reader = new ReadAdminRoomTopologyWork({ repository: { findByKey: async () => entry }, nowEpochMs: () => NOW });
    for (const status of [EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED]) {
        entry = { ...entry, status };
        expect(await reader.read(request)).toMatchObject({ status: 'pending' });
    }
    for (const status of [EntityStatus.FAILED, EntityStatus.NON_RETRYABLE, EntityStatus.ABORTED]) {
        entry = { ...entry, status };
        expect(await reader.read(request)).toMatchObject({ status: 'failed' });
    }
    entry = { ...entry, status: EntityStatus.MERGED };
    await expect(reader.read(request)).rejects.toThrow();
    entry = { ...entry, status: EntityStatus.COMPLETED };
    await expect(reader.read(request)).rejects.toThrow();
});

it('rejects foreign work, corrupt payloads and mismatched storage identity instead of guessing an outcome', async () => {
    const entry = computeRtcTopologyOutboxInsert(work).entry;
    const findByKey = vi.fn(async () => entry);
    const reader = new ReadAdminRoomTopologyWork({ repository: { findByKey }, nowEpochMs: () => NOW });
    await expect(reader.read({ ...request, roomRef: { ...request.roomRef, workspaceId: 'foreign' } })).rejects.toThrow();
    await expect(reader.read({ ...request, outboxId: 'other-command' })).rejects.toThrow();
    findByKey.mockResolvedValue({ ...entry, resource: '{}' });
    await expect(reader.read(request)).rejects.toThrow();
    findByKey.mockResolvedValue({ ...entry, key: { ...entry.key, contextId: 'foreign' } });
    await expect(reader.read(request)).rejects.toThrow();
});

it('accepts the complete receipt identity when the original request uses the maximum route ID length', async () => {
    const outboxId = `${'a'.repeat(128)}:rtc-topology-recompute:explicit`;
    const entry = computeRtcTopologyOutboxInsert({ ...work, resourceId: outboxId }).entry;
    const reader = new ReadAdminRoomTopologyWork({ repository: { findByKey: async () => entry }, nowEpochMs: () => NOW });
    expect(await reader.read({ ...request, outboxId })).toMatchObject({ outboxId, status: 'pending' });
});

it('returns only canonical room identity even when an internal caller holds a full room record', async () => {
    const entry = computeRtcTopologyOutboxInsert(work).entry;
    const reader = new ReadAdminRoomTopologyWork({ repository: { findByKey: async () => entry }, nowEpochMs: () => NOW });
    const heldRoom = { ...request.roomRef, metadata: { privateValue: 'must-not-be-returned' } };
    expect((await reader.read({ ...request, roomRef: heldRoom })).roomRef).toEqual(request.roomRef);
});
