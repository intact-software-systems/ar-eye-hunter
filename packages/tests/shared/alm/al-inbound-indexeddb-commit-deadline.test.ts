import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageAdmission } from '@shared/alm/inbound/al-inbound-message-admission.ts';
import { decodeALDeadlinedMessage } from '@shared/alm/inbound/al-inbound-message-deadline.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_SCHEMA_KEY,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import '../../setup-browser-indexeddb.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

afterEach(() => vi.restoreAllMocks());

it.each(['get', 'put'] as const)('rolls back admission when native %s completion crosses original D', async (method) => {
    for (const replay of [false, true]) {
        for (const offset of [-1, 0, 1]) {
            let nowMs = 1_800_000_000_000;
            vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
            const dbName = `native-deadline-${crypto.randomUUID()}`;
            const backend = new IndexedDbAdmissionBackend({
                schemaId: AL_ADMISSION_SCHEMA_ID,
                onStorageReset: () => {},
                dbName: dbName,
                storeName: 'entries',
                nowMs: () => nowMs,
                newWriteToken: crypto.randomUUID.bind(crypto),
                observer: createPassThroughIndexedDbOperationObserver()
            });
            const store = createALInboundAdmissionStore({
                nowMs: Date.now,
                namespace: 'deadline',
                backend,
                orderingTrackTtlMs: 60_000,
                supersedenceTrackTtlMs: 60_000,
                retention: normalizeALRuntimeStoreRetention()
            });
            const planner: ALInboundMessageRuntime.Dependencies['planIncomingMessage'] = (msg, source, observations) =>
                planALMessageHandling(msg, {
                    ...observations,
                    selfPeerId: 'receiver',
                    fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId
                });
            const admission = new ALInboundMessageAdmission({
                admissionStore: store,
                workPort: createTestALInboundWorkPort({
                    admissionStore: store,
                    workQueue: backend.workQueue,
                    nowMs: () => nowMs
                }),
                clock: { nowMs: () => nowMs },
                planIncomingMessage: planner,
                effectPreparation: {
                    newControlId: crypto.randomUUID.bind(crypto),
                    selfPeerId: 'receiver',
                    createInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'INBOX')
                },
                forwardMessage: undefined,
                canForwardMessage: undefined
            });
            const message = newALUnicastMessage(
                'sender',
                { topicId: 'chat', resourceId: 'deadline', contextId: 'room' },
                'receiver',
                'chat',
                {},
                { ttlMs: 1_000, qos: { ack: { algo: 'hop' } } }
            );
            const deadline = message.constraints!.expiresAtMs!;
            const original = IDBObjectStore.prototype[method];
            let crossed = false;
            const requestSpy = vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, value: IDBValidKey | IDBKeyRange) {
                const request = original.call(this, value);
                if (this.transaction.mode === 'readwrite' && this.name === 'entries') {
                    request.addEventListener('success', () => {
                        nowMs = deadline + offset;
                        crossed = true;
                    });
                }
                return request;
            });
            try {
                const source = { kind: 'rtc-peer' as const, peerId: 'sender' };
                if (replay) {
                    expect(await admission.replay({ kind: 'admit-message', msg: decodeALDeadlinedMessage(message), source })).toBe('completed');
                }
                else {
                    const outcome = await admission.attempt(message, source, planner);
                    expect(outcome.right).toEqual({
                        kind: 'completed',
                        acceptance: offset < 0
                            ? { kind: 'admitted' }
                            : { kind: 'not-admitted', reason: 'expired' },
                        wroteWork: offset < 0
                    });
                }
                expect(crossed).toBe(true);
                requestSpy.mockRestore();
                const db = await openIndexedDbAdmissionDatabase({
                    dbName: dbName,
                    storeName: 'entries',
                    schemaId: AL_ADMISSION_SCHEMA_ID,
                    onStorageReset: () => {}
                });
                try {
                    const transaction = db.transaction(['entries', 'alm-work'], 'readonly');
                    const [metadata, work] = await Promise.all([
                        readIndexedDbRequest(transaction.objectStore('entries').getAll()),
                        readIndexedDbRequest(transaction.objectStore('alm-work').getAll())
                    ]);
                    expect(
                        metadata.filter((row) => row.key !== AL_ADMISSION_REVISION_KEY && row.key !== AL_ADMISSION_SCHEMA_KEY).length > 0
                    ).toBe(offset < 0);
                    expect(work.length > 0).toBe(offset < 0);
                }
                finally {
                    db.close();
                }
            }
            finally {
                admission.dispose();
                requestSpy.mockRestore();
                vi.restoreAllMocks();
            }
        }
    }
});
