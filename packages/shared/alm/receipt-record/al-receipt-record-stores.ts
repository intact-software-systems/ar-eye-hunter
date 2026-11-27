import { Temporal } from '@js-temporal/polyfill';

import { InMemoryQueueBox } from '../../queuebox/in-memory-queue-box.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '../al-admission-work-backend.ts';

import { toALReceiptRecordNamespace } from './al-receipt-record-keys.ts';

export interface ALReceiptRecordStores {
    readonly backend: ALAdmissionWorkBackend;
    /** The record's own namespace, `toALReceiptRecordNamespace` of its owner's store namespace. */
    readonly namespace: string;
}

export function createInMemoryALReceiptRecordStores(
    storeNamespace: string,
    nowMs: () => number
): ALReceiptRecordStores {
    const workQueue = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    return {
        backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(workQueue), nowMs),
        namespace: toALReceiptRecordNamespace(storeNamespace)
    };
}
