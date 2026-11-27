import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { toALReceiptRecordNamespace } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    describeALReceiptRecordContract,
    type ALReceiptRecordContractInstance
} from './al-receipt-record-contract.ts';

const namespace = toALReceiptRecordNamespace('receipt-record-test');

describeALReceiptRecordContract('memory', async () => {
    const startMs = Date.now();
    const clocks = [{ nowMs: startMs }, { nowMs: startMs }, { nowMs: startMs }] as const;
    // The memory queue has one clock of its own; the first instance's stands in for the shared store's.
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clocks[0].nowMs))
    );
    const toInstance = (clock: { nowMs: number; }): ALReceiptRecordContractInstance => {
        const backend = new InMemoryAdmissionBackend(state, () => clock.nowMs);
        return { record: new ALReceiptRecord({ backend, namespace, nowMs: () => clock.nowMs }), backend, clock };
    };
    return {
        namespace,
        instances: [toInstance(clocks[0]), toInstance(clocks[1]), toInstance(clocks[2])],
        fencedWriteClock: 'instance'
    };
});

function createBackendWhoseWritesReject(error: Error): ALAdmissionWorkBackend {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    return Object.assign(backend, { write: async () => await Promise.reject(error) });
}

const ref = { originPeerId: 'origin', msgId: 'msg' };

describe('ALReceiptRecord at its storage boundary', () => {
    // Review Focus 5: only the backend's conflict is an expected failure. Read as 'conflict', an outage would be
    // retried as a race forever; it must reach the caller unchanged.
    it('lets a storage failure propagate unchanged', async () => {
        const backend = createBackendWhoseWritesReject(new Error('storage down'));
        const record = new ALReceiptRecord({ backend, namespace, nowMs: Date.now });

        await expect(record.count({ ...ref, recipientPeerId: 'r1', kind: 'confirmed' })).rejects.toThrow(
            'storage down'
        );
    });

    it('returns a backend conflict as a value', async () => {
        const backend = createBackendWhoseWritesReject(new ALAdmissionBackendConflictError('raced'));
        const record = new ALReceiptRecord({ backend, namespace, nowMs: Date.now });
        const opening = {
            ...ref,
            traceId: 'trace',
            expectedRecipientPeerIds: ['r1'],
            neverSentRecipientPeerIds: [],
            snapshotVersion: 1,
            deadlineAtMs: Date.now() + 5_000
        };

        expect((await record.open(opening)).left).toEqual({ kind: 'conflict' });
    });

    // A conflicting write is a repeat only when the row it lost to is there to read; with no row, nothing proves the
    // recipient was counted, so the caller must be told to retry rather than told it was already counted.
    it('returns a conflict when the confirmation it lost to is not there', async () => {
        const backend = createBackendWhoseWritesReject(new ALAdmissionBackendConflictError('raced'));
        const record = new ALReceiptRecord({ backend, namespace, nowMs: Date.now });

        expect((await record.count({ ...ref, recipientPeerId: 'r1', kind: 'confirmed' })).left).toEqual({
            kind: 'conflict'
        });
    });
});
